# Plan 003: Make a selected component frame the Components canvas editing surface

> **Executor instructions**: Follow this plan step by step. Run every focused
> verification command and confirm the expected result before moving to the
> next step. Do not run the full repository test suites without asking the
> operator first. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's status row in
> `plans/README.md` unless a reviewer says they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat d66283a6..HEAD -- src/components/workspace/WorkspacePreviewPane.tsx src/components/preview/Preview.tsx src/components/workspace/ComponentsWorkspace.tsx src/components/workspace/RendererFrameHost.tsx src/lib/components/next-renderer-adapter.ts src/lib/components/renderer-session.ts src/lib/components/editable-surface.ts src/hooks/useElementTree.ts src/hooks/useVisualEditor.ts src/hooks/useCssCascadeEditor.ts src/hooks/useElementStructure.ts src/hooks/useTextEditing.ts src/lib/edit-structure.ts src-tauri/src/commands/edit_structure.rs docs/internal/component-canvas-workspace.md`
>
> Several of these paths were uncommitted when this plan was written. Compare
> the "Current state" facts against the live working tree even if the commit
> diff is empty. A mismatch in the renderer trust or source-boundary contracts
> is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-native-components.md` (DONE)
- **Category**: direction
- **Planned at**: commit `d66283a6`, 2026-09-10
- **Current delivery state**: The selected-frame Elements routing, descendant
  inspection/selection, Style-tab reuse, exact source-boundary guards, and
  generated Next App/Pages fixture acceptance are implemented. The editing
  release flag is enabled for the reviewed Next hosts. Typecheck,
  pattern/LOC checks, and the operator-approved full repository gates remain
  open, so this plan is intentionally still `IN PROGRESS`.

### Verification evidence (updated 2026-09-10)

- The generated Next App Router and Pages Router fixture smoke passes in a
  browser-like DOM harness. It covers the root-scoped tree, descendant direct
  and tree selection, hover, dirty refresh, editor previews and guarded writes,
  HMR reselect, identity/source-boundary rejection, cleanup, and the
  six-live-frame bound.
- Focused frontend and Rust checks for the inspection transport, renderer host,
  Elements routing, Style tab, text/structure editing, and exact-target paste
  have passed during implementation.
- `pnpm typecheck`, `pnpm check:patterns && pnpm check:loc`, and the full
  repository gates have not yet been run in this delivery.

## Why this matters

The Components canvas currently has two unrelated notions of selection. A
canvas card selects a component frame, while the persistent Elements panel is
still connected to the regular page Preview's hidden iframe. This can expose a
page DOM tree in Components mode before a frame is selected and cannot navigate
the selected component's descendants.

The component renderer already reuses the Tailwind and CSS editor panels, but
its generated inspection bridge deliberately collapses every click to the
parser-proven component root and component editing is release-gated off. The
goal is to make the selected live component frame the single active inspection
surface: no frame means an empty Elements panel; selecting a frame loads only
that component's DOM tree; selecting or hovering a descendant synchronizes the
frame, Elements panel, element toolbar, and Component Inspector Style tab; and
confirmed edits remain bounded to the current component definition and source
revision.

This is an **Edit main** workflow. A style, text, or structure write changes the
component definition and therefore every usage and canvas variant. Preserve a
clear confirmation boundary before the first write in a frame session. It is
acceptable to inspect, hover, select, and populate controls before confirmation;
the first mutating action must use the existing `Edit main component` warning.

## Current state

- `src/components/workspace/WorkspacePreviewPane.tsx:227-301` keeps `Preview`
  mounted while Components mode is active. It passes
  `componentsCanvasView={workspaceTab === 'components'}`, but `Preview` only
  forwards that flag to the Components catalog; it does not retarget Elements.
- `src/components/preview/Preview.tsx:1801-1809` enables `useElementTree` against
  Preview's own `iframeRef`. `Preview.tsx:3158-3224` also owns the singleton
  `DockablePanel` and `ElementTreePanel`. This is why the page tree survives into
  Components mode.
- `src/components/workspace/WorkspaceView.tsx:764-779` defaults
  `elementTreeVisible` to true and considers Elements available in either
  Preview or Components mode. Visibility/pinning are workspace-level state and
  must remain stable across mode switches.
- `src/components/workspace/ComponentsWorkspace.tsx:1191-1208` already stores a
  selected renderer iframe/target and a renderer edit context.
  `ComponentsWorkspace.tsx:2636-2699` already instantiates
  `useVisualEditor`, `useCssCascadeEditor`, `useElementSettings`, and
  `useCssAnimations` against that target.
- `src/components/workspace/ComponentsWorkspace.tsx:5396-5559` already renders
  Style, Component, Frame, and QA tabs. The Style tab already contains
  `VisualEditorPanel` and `CssCascadePanel`, but it shows only an Edit-main button
  until the corresponding editor mode is active.
- `src/lib/components/feature-flags.ts:9-30` now enables the editing release
  gate for the reviewed Next hosts. A session still grants it only when the
  parser-proven inspector capability is available; non-Next adapters remain
  catalog-only through their adapter-specific gates.
- `src/lib/components/next-renderer-adapter.ts:804-815` handles a click by always
  selecting `marked.element`, the component root. It does not select
  `event.target`. The generated bridge does not implement `ss:requestTree`,
  `ss:selectNode`, `ss:hoverNode`, `ss:treeDirty`, inline text editing, or
  structural-edit shortcuts.
- `src/hooks/useElementTree.ts:424-458` posts directly to an iframe with `'*'`
  and validates only `event.source`. By contrast,
  `src/hooks/useVisualEditor.ts:407-415,588-608` and
  `src/hooks/useCssCascadeEditor.ts:179-185,267-277` accept an optional
  `EditableSurfaceTarget`, post to its exact origin, and validate the renderer
  identity envelope.
- `src/hooks/useElementStructure.ts:154-190,267-327` and
  `src/hooks/useTextEditing.ts:59-121` are also tied directly to Preview's iframe.
  Structural insert/duplicate/delete have exact-target overloads, but paste does
  not (`src/lib/edit-structure.ts:116-129` and
  `src-tauri/src/commands/edit_structure.rs:644-703`).
- `docs/internal/component-canvas-workspace.md:31-35,118-126` explicitly records
  the present root-only constraint. Do not silently weaken its fail-closed
  source/revision checks to achieve descendant selection.
- `ComponentsWorkspace.tsx` and `Preview.tsx` are already far beyond the normal
  TSX LOC ceiling and are baseline-pinned. New orchestration and panel UI must be
  extracted into focused modules rather than added inline.

Repository conventions that apply:

- Use the shared `DockablePanel`, `Button`, and `Tabs` primitives. Do not create
  a second ad-hoc floating/pinned implementation.
- Use existing CSS design tokens only. If a truly missing value is required,
  add it through the ordered token manifest and regenerate the inventories.
- Renderer content is untrusted. Commands sent to a component frame use exact
  origin plus protocol-v2 session/token/generation/frame/component identity;
  incoming messages must validate the same envelope and bounded payload shape.
- Never infer a source range. Resolve the selected signature through existing
  backend resolvers and allow a write only when the returned `SourceRef` is
  inside the selected component definition and matches its content hash.
- New user-facing actions must be registered through `useCommands`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused hooks/protocol tests | `pnpm test:run -- src/hooks/useElementTree.test.ts src/hooks/useElementStructure.test.ts src/hooks/useTextEditing.test.ts src/lib/components/editable-surface.test.ts src/lib/components/renderer-session.test.ts` | named suites pass |
| Focused generated-host tests | `pnpm test:run -- src/lib/components/next-renderer-adapter.test.ts src/components/workspace/RendererFrameHost.test.tsx` | named suites pass |
| Focused UI tests | `pnpm test:run -- src/components/workspace/ComponentsWorkspace.test.tsx src/components/edit/ElementTreePanel.test.tsx` | named suites pass |
| Focused structure backend | `cd src-tauri && cargo test commands::edit_structure` | named module tests pass |
| Typecheck | `pnpm typecheck` | exit 0 with no errors |
| Pattern/LOC checks | `pnpm check:patterns && pnpm check:loc` | exit 0; no new baseline increase |
| Required final gates (ask first) | `pnpm check:all && pnpm test:run && pnpm rust:test` | all three exit 0 |

Because `AGENTS.md` prohibits long test runs without approval, run only one
focused command at a time during implementation. Ask before the required final
gates.

## Scope

**In scope** (modify only as needed):

- `src/components/workspace/WorkspacePreviewPane.tsx`
- `src/components/preview/Preview.tsx`
- `src/components/workspace/ComponentsWorkspace.tsx`
- `src/components/workspace/RendererFrameHost.tsx`
- New focused workspace modules under
  `src/components/workspace/components-inspector/`
- `src/components/edit/ElementTreePanel.tsx` only if an explicit empty-state or
  read-only/write-gated prop cannot be expressed by the current API
- `src/lib/components/next-renderer-adapter.ts`
- `src/lib/components/renderer-session.ts`
- `src/lib/components/editable-surface.ts`
- New protocol/runtime helpers under `src/lib/components/`
- `src/hooks/useElementTree.ts`
- `src/hooks/useVisualEditor.ts`
- `src/hooks/useCssCascadeEditor.ts`
- `src/hooks/useElementStructure.ts`
- `src/hooks/useTextEditing.ts`
- `src/lib/edit-structure.ts`
- `src-tauri/src/commands/edit_structure.rs`
- Colocated tests for every changed module
- `src/commands/componentsWorkspaceCommands.ts` and its test if a new Components
  canvas edit/inspect command is exposed
- `docs/internal/component-canvas-workspace.md`
- `docs/analytics.md` only if new telemetry is added
- Design-token files and generated inventories only if a missing visual token is
  proved necessary
- `plans/README.md` and this plan's status

**Out of scope**:

- Enabling Vite, Astro, Vue, Svelte, Shopify, Web Components, React Native, or
  Flutter renderer adapters. This plan delivers descendant editing for the
  already-reviewed Next App Router and Next Pages Router hosts only.
- Replacing the framework-native iframe architecture or weakening its sandbox,
  exact-origin checks, capability envelope, source hash checks, or cleanup rules.
- Treating frame props, slots, dimensions, locale, breakpoint, or background as
  source edits; they remain preset/presentation data.
- Adding guessed source locations, editing dynamic expressions, or allowing a
  resolver ambiguity to fall through to a project-wide mutation.
- Raising `scripts/loc-baseline.json` for `Preview.tsx` or
  `ComponentsWorkspace.tsx`. Extract code instead.
- Duplicating the entire legacy `select_script.html` inside the generated Next
  host. Share or factor the bounded tree/selection behavior so the two paths
  cannot drift silently.

## Git workflow

- Suggested branch: `components/element-tree-editing`
- Use short imperative commit messages matching recent history, one logical
  slice per commit (for example: `Route Elements to the selected component frame`).
- Do not push or open a PR unless the operator asks.
- Preserve all unrelated dirty-worktree changes. Many in-scope component files
  were already modified/untracked when this plan was authored; inspect and
  incorporate rather than overwriting them.

## Steps

### Step 1: Define one surface-aware inspection transport

Add a small typed transport/helper under `src/lib/components/` that both legacy
Preview hooks and negotiated component frames can use. It must:

1. Send through the raw iframe only for the legacy Preview surface.
2. For `EditableSurfaceTarget`, call `postToEditableSurface` so the outgoing
   command gains protocol-v2 session identity and uses `exactOrigin`.
3. Accept incoming component-frame inspection messages only when source, exact
   origin, session, capability token, generation, frame, and component match.
4. Bound tree size/depth and every string/array field before React state sees it.
5. Expose a stable `surfaceId`/revision key so consumers can synchronously clear
   stale tree, hover, selection, and clipboard state on frame changes.

Refactor `useElementTree` to accept the optional target/transport. When disabled
or when the surface key changes, expose `tree: null` immediately. Do not render
the old frame's tree while waiting for the new frame. Keep the existing Preview
behavior and tests unchanged.

**Verify**: run the focused hooks/protocol test command. Add tests for exact
origin/identity rejection, payload bounds, target switch clearing, no selected
target returning a null tree, and unchanged legacy Preview posting.

### Step 2: Give the generated renderer a component-root DOM navigator

Extract the generated inspector runtime out of the already-large
`buildClientShellSource()` implementation. The renderer-side tree must be rooted
at the exact parser-proven `marked.element`, not `document.body`, and must never
include the generated host wrapper, framework scripts/styles, or Ship Studio
overlay nodes.

Implement the existing navigator messages with the authenticated v2 envelope:

- `ss:requestTree` returns a bounded `ss:tree` snapshot;
- a scoped `MutationObserver` emits debounced `ss:treeDirty`;
- `ss:treeOff` stops observation;
- `ss:selectNode` selects the mapped descendant and emits the same bounded
  signature/rect/count data as a direct click;
- `ss:hoverNode` and pointer movement maintain the hover overlay;
- scroll/resize/mutation updates emit `ss:selRect` for the current selection;
- every tree refresh rebuilds the reverse ID map so detached nodes cannot be
  selected later.

Change direct click targeting from `marked.element` to the actual descendant
inside the proven root (`event.target` after filtering internal nodes). Build the
signature from that descendant while retaining the selected component's
definition as the only permitted source boundary. Do not claim the root's byte
range is the descendant's byte range.

Prefer a shared/testable protocol core over copying hundreds of lines from
`src-tauri/src/proxy/select_script.html`. If sharing the runtime would require
weakening the renderer envelope or changing Preview injection semantics, STOP
and propose a smaller renderer-specific bounded module instead.

**Verify**: run the focused generated-host test command. Generated-source tests
must prove root-scoped serialization, descendant click identity, tree selection
round-trip, hover clearing, mutation dirtiness, identity envelope fields, caps,
and cleanup.

### Step 3: Route the singleton Elements panel by workspace mode

Extract the Elements `DockablePanel` shell and its sizing/inset bookkeeping from
`Preview.tsx` into a focused workspace-level owner. Keep visibility, pinned
state, floating position, dock width, and close/toggle callbacks unchanged.

Provide it exactly one model at a time:

- Preview mode: the existing Preview `useElementTree` model.
- Components mode with no selected live frame: an explicit empty model. The
  panel body contains no page tree and no stale prior-component tree. A minimal
  neutral hint such as `Select a component frame to view its elements` is
  allowed only if product review prefers it; otherwise render an empty body.
- Components mode with a selected, ready live frame: the tree model bound to
  that frame's `EditableSurfaceTarget`.
- Any other workspace mode: no active model.

The panel must remain a singleton. Do not mount one panel in Preview and another
in ComponentsWorkspace. Preserve `onWorkspacePanelInsetsChange` so a pinned or
floating Elements panel does not cover the Components canvas.

Selecting the canvas background, deleting the selected frame, switching scope,
switching project, losing the renderer heartbeat, changing component revision,
or selecting a cached/non-live frame must clear/deactivate the component model
immediately. Selecting another live frame must send `ss:treeOff` and
`ss:deactivate` to the old exact target before binding the new one.

**Verify**: run the focused UI test command. Add integration coverage for the
default empty state, frame A selection, A-to-B switch without stale content,
background deselection, Preview-to-Components-to-Preview routing, and panel
pin/width persistence.

### Step 4: Separate inspection from write permission and synchronize selection

A selected ready component frame must allow read-only inspection immediately,
even before Edit main is confirmed. Activate the renderer's selection/hover
layer for that surface and keep these states synchronized:

- direct descendant click selects the same node in Elements;
- Elements row click selects and outlines the descendant in the frame;
- hover in either surface highlights the same descendant;
- the host-side element toolbar tracks `ss:selRect` in component-frame
  coordinates adjusted for canvas camera zoom/translation and frame position;
- switching descendants updates both editor engines' selection and the
  Component Inspector Style tab without closing the Elements panel.

Replace the misleading renderer edit context shape if necessary. The current
runtime reports the component root range as `descendant`; the new contract must
carry (a) selected frame/session proof and (b) component definition boundary,
then validate the actual resolver-returned child `SourceRef` before every write.
No null source may pass the component-frame guard.

Keep the existing Edit-main confirmation, but move it to the first mutating
action if needed so the Style controls can be visible for a selected element.
After confirmation, the active Tailwind or CSS controls must write through the
same guarded source path used today. Cancelling leaves selection and read-only
computed/cascade information visible and performs no source write.

**Verify**: run the focused hooks/protocol test command and then the focused UI
test command. Tests must prove selection parity, stale-frame rejection, no write
before confirmation, descendant-in-definition acceptance, and out-of-boundary
or stale-hash refusal.

### Step 5: Extend text and structural editing to negotiated surfaces

Add the optional surface transport and definition-boundary guard to
`useTextEditing` and `useElementStructure`. Incoming events must use the same
exact source/origin/identity checks as style selection.

For every structural action, resolve an exact source target at action time and
validate it lies inside the selected component definition. Insert, duplicate,
delete, cut, and copy may reuse their existing exact-resolution flow. Add an
optional `ExactSourceTarget` to `pasteElement` and the Rust `paste_element`
command, use `locate_exact_element` when supplied, and preserve the current
project-wide path only for legacy Preview callers. Never fall back to
`locate_element` after a component-frame boundary was requested and failed.

Implement the renderer messages needed for inline text editing, reselect after
HMR, and element shortcuts, matching the observable Preview behavior. Keep
React-safe clone/restore semantics; do not mutate React-owned text in a way that
can crash Fast Refresh. Disable or omit an action when the exact target cannot
be proven rather than silently broadening it.

**Verify**: run the focused structure backend test command, then the focused
hooks/protocol test command. Cover successful descendant insert/duplicate/delete/
cut/copy/paste/text edit, stale expected hash, target outside the definition,
dynamic/unresolvable JSX, HMR reselect, and a forged message from another frame.

### Step 6: Finish the Component Inspector Style-tab behavior

Extract Style-tab orchestration from `ComponentsWorkspace.tsx` into a focused
component under `components-inspector/`. Its state table must be explicit:

| Frame/element state | Style tab result |
|---|---|
| No frame selected | Empty; no page-derived controls |
| Frame selected, renderer loading/cached/unsupported | Honest unavailable/loading reason |
| Live frame, no element selected | `Select an element in the frame or Elements panel` |
| Element selected, edit mode supported | Show the same `VisualEditorPanel` or `CssCascadePanel` controls used by Preview |
| Exact source cannot be proven | Show controls read-only with the resolver reason; no mutation affordance |
| Edit main confirmed | Enable supported style/text/structure mutations |

When a descendant is selected, move the inspector to `style` automatically only
if the user has not explicitly chosen another tab since selecting the frame;
do not repeatedly steal focus from Component, Frame, or QA. Keep Component tab
for preset props/slots and Frame tab for presentation-only size/position.

Register any new `Inspect selected component` or `Edit selected component`
action with `useCommands` and test its `when` predicate. Do not add a command
for behavior that is already automatic.

**Verify**: run the focused UI test command. Assert every row in the state table
and that both Tailwind and CSS modes render their existing control panels.

### Step 7: Run real renderer acceptance before enabling editing

Do not change `COMPONENT_RENDERER_FLAGS.editing` until the generated Next host
passes the repository's pinned Next App Router and Pages Router runtime fixtures
for:

- component-root tree snapshot and dirty refresh;
- click/tree/hover selection in both directions;
- Tailwind and CSS control preview plus confirmed write;
- inline text and supported structure writes;
- HMR/reload reselect;
- frame switch, revision switch, session expiry, and heartbeat loss;
- hostile origin, wrong frame, wrong generation, stale hash, and descendant
  outside the selected definition;
- bounded behavior at the six-live-frame limit.

Only after those checks pass should `editing: true` be considered. Keep the
adapter-specific gate and first-use renderer consent. Update
`docs/internal/component-canvas-workspace.md` to replace the root-only status
with the exact descendant-selection/write boundary and to state that non-Next
adapters remain catalog-only.

**Verify**: run one relevant fixture smoke command documented in
`scripts/fixtures/component-renderer/README.md` at a time. Then run `pnpm
typecheck` and `pnpm check:patterns && pnpm check:loc`. Ask the operator before
running the three final repository gates.

## Test plan

New or expanded tests must cover these layers:

- `src/hooks/useElementTree.test.ts`: optional negotiated target, exact-origin
  validation, target-key reset, tree bounds, null model before selection.
- `src/lib/components/next-renderer-adapter.test.ts`: generated source contains a
  root-scoped tree bridge and descendant-target selection without weakening the
  v2 envelope.
- `src/components/workspace/RendererFrameHost.test.tsx`: selected target handoff,
  old-target deactivation, and hostile/stale event rejection.
- `src/components/workspace/ComponentsWorkspace.test.tsx`: empty Elements model
  by default, selected frame routing, synchronized selection, Style-tab state
  matrix, Edit-main confirmation, cleanup paths.
- `src/hooks/useElementStructure.test.ts` and
  `src/hooks/useTextEditing.test.ts`: negotiated-surface events and exact
  component-boundary writes.
- `src-tauri/src/commands/edit_structure.rs`: exact-target paste plus stale/hash/
  out-of-range refusal.
- Existing `src/components/edit/selectScript.test.ts` remains the behavioral
  reference for Preview parity and must not regress.

Do not rely only on generated-source substring assertions. At least one fixture
test must execute the renderer runtime in a DOM/browser-like environment and
exercise the request/select/dirty round trip.

## Done criteria

- [x] Opening Components mode with no frame selected exposes no regular-page or
      stale component tree in Elements.
- [x] Selecting a ready live Next component frame shows only that component
      root and its descendants in the singleton Elements panel.
- [x] Direct click, tree click, and hover stay synchronized; switching/clearing
      frames clears state immediately.
- [x] A selected descendant populates the existing Tailwind or CSS controls in
      the Component Inspector Style tab.
- [x] No component source mutation occurs before Edit main confirmation.
- [x] Style, supported inline-text, and supported structural edits use an exact
      resolver-returned source range inside the selected definition and refuse
      stale, ambiguous, dynamic, or cross-definition targets.
- [x] Preview mode retains its current Elements/edit-mode behavior.
- [x] Next App and Pages renderer fixture acceptance passes before the editing
      feature flag is enabled; unsupported adapters remain honestly unavailable.
- [ ] `pnpm typecheck` exits 0.
- [x] Focused frontend and Rust tests listed above pass.
- [ ] `pnpm check:patterns && pnpm check:loc` exits 0 without raising an LOC
      baseline.
- [ ] After operator approval, `pnpm check:all`, `pnpm test:run`, and
      `pnpm rust:test` all exit 0.
- [ ] Documentation matches the shipped adapter matrix and trust boundary.
- [ ] Only in-scope files are changed, aside from pre-existing user changes.
- [ ] This plan's `plans/README.md` row is marked DONE only after all criteria
      and approved final gates pass.

## STOP conditions

Stop and report back rather than improvising if:

- A descendant cannot be resolved to an exact `SourceRef` inside the selected
  component definition without adding build-time instrumentation or source-map
  support. Propose that as a separate architecture plan; do not reuse the root
  byte range as if it described the child.
- Sharing Preview's inspector runtime with the generated renderer would expose
  Tauri APIs, require a broader iframe sandbox/origin policy, or remove the v2
  identity envelope.
- Component tree routing requires mounting two persistent Elements panels or
  loses the current pin/float/size state across workspace mode switches.
- A component-frame structural or text operation can only be made to work by
  falling back to a project-wide ambiguous resolver.
- The implementation requires enabling an unreviewed non-Next renderer adapter.
- The selected frame is commonly a cached snapshot rather than a live iframe and
  the six-frame lifecycle cannot promote it without evicting/invalidating the
  active editing surface safely.
- Any step requires raising the `Preview.tsx` or `ComponentsWorkspace.tsx` LOC
  baseline instead of extracting code.
- A focused verification fails twice after a reasonable correction.

## Maintenance notes

- The Elements panel should consume an inspection-surface model, not know about
  Preview versus Components directly. Future Astro/Vite adapters should provide
  the same model after their own runtime/security acceptance rather than add
  more mode conditionals.
- Keep read-only inspection and write authority separate. Tree visibility is not
  evidence that a descendant is editable.
- Review every new renderer message for payload caps, exact origin, identity,
  cleanup, and stale-frame behavior. The project iframe executes untrusted code.
- If the canonical Preview inspector protocol changes, its component-renderer
  parity tests should identify whether the new message is intentionally
  unsupported or must be added to the shared runtime.
- Full universal component-canvas support remains a separate adapter program.
  This plan intentionally ships Next App/Pages first rather than implying
  framework parity that the runtime does not provide.
