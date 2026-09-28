# Components canvas migration plan

Status: Stage 1 scene foundation in progress. The pure v2 adapter, geometry,
transaction history, and input guards are additive and do not change the
renderer, canvas schema, or current integration contracts.

The target is a Grida-like editor experience, implemented independently from
Ship Studio's existing architecture and security model. The behavioral
reference is pinned to Grida commit
`f6110ab6921fe50c1471cf8e077cb353c5569ad9`. This is an independent
behavioral reimplementation: no Grida runtime, scene engine, markup, CSS, or
source files are copied into Ship Studio. Ship Studio's renderer isolation,
consent, origin/capability validation, cleanup, and current integration
contracts remain authoritative.

## Current inventory and boundaries

| Area | Current implementation | Migration disposition |
| --- | --- | --- |
| Workspace shell | `src/components/workspace/ComponentsWorkspace.tsx` (large controller/view), `WorkspacePreviewPane.tsx`, `WorkspaceView.tsx`, `WorkspaceModes.tsx`, `workspaceViewState.ts` | Keep the shell and navigation contracts; replace the canvas internals incrementally. |
| Canvas data and persistence | `src/lib/components/canvas.ts`, `canvas-storage.ts`, `presets.ts` | Keep v2 parsing and project persistence; introduce a versioned adapter and scene operations behind it. |
| Camera and visibility | `canvas-camera.ts`, `canvas-culling.ts` | Replace with a tested scene-camera/geometry layer while preserving stored camera compatibility. |
| Renderer host | `RendererFrameHost.tsx`, `RendererSetupModal.tsx`, `renderer-session.ts`, `renderer-lifecycle.ts`, `renderer-readiness.ts`, `renderer-registry.ts`, renderer adapters, and `src-tauri/src/commands/components/renderer.rs` | Preserve the security and lifecycle boundary; improve scheduling/retention only behind the same contract. |
| Catalog and source data | `useComponentCatalog.ts`, `src/lib/components/component-worker*`, parser/adapters/types, source watcher and editor hooks | Keep as the source-of-truth catalog. The canvas consumes immutable catalog snapshots, never project code. |
| Workspace integration | `ComponentsPanel.tsx`, `Preview.tsx`, `DockablePanel.tsx`, `WorkspacePreviewPane.tsx`, `useWorkspaceLayout.ts`, `App.tsx`, and workspace command hooks | Keep public props, panel behavior, insets, navigation, and command IDs. |
| Styling | `src/styles/features/component-workspace.css` and shared token layers | Replace only canvas-specific rules using existing design tokens; do not reintroduce raw values. |
| Tests and fixtures | Colocated workspace/canvas/renderer tests and `scripts/fixtures/component-renderer/` | Retain fixtures and security tests; add deterministic scene/gesture/performance coverage. |
| Legacy reference | `ComponentCanvas.tsx` and `component-canvas.css` are deleted in the current dirty worktree | Do not restore them accidentally. They are preserved as `legacy-head/` references in the backup. |

Current behavior is a DOM card board with bounded document nodes, three scopes
(`focus`, `variants`, `all`), camera pan/zoom, selection, drag, duplicate and
delete, presets, and six initial live frame requests. Documents persist in
`.shipstudio/project.json` under `component_canvas` with a 512 KiB limit;
presets use project-hashed local storage. Source projects are parsed as data,
not imported or executed by Ship Studio. Next App/Pages rendering is enabled
only through project-scoped, versioned consent; other framework types remain
catalog-only. v2 sessions validate exact origin, capability token, generation,
frame, and revision, with TTL and session/node limits.

## Proposed modules

The first implementation should sit beside the current workspace so rollback is
cheap. Recommended names and responsibilities are:

```text
src/components/workspace/components-canvas/
  ComponentsCanvas.tsx       composition and public workspace adapter
  CanvasViewport.tsx         scroll/viewport and coordinate transforms
  CanvasWorld.tsx            scene surface and virtualization boundary
  CanvasNode.tsx             node presentation and pointer target
  CanvasSelectionOverlay.tsx handles, marquee, guides, and selection chrome
  CanvasToolbar.tsx          zoom, fit, scope, and layout actions
  CanvasInspector.tsx        multi-selection-aware property editing
  CanvasGestures.ts          pointer, wheel, pinch, keyboard, and edge-scroll FSM
src/lib/components/
  canvas-document.ts         v2 adapter, scene schema, validation, migration
  canvas-geometry.ts         bounds, transforms, snapping, guides, hit testing
  canvas-history.ts          canvas transactions separate from source undo/redo
  canvas-renderer-scheduler.ts frame budget, retention, and cancellation
```

`ComponentsWorkspace.tsx` can remain a compatibility coordinator while these
modules are introduced. The primary replacement candidates are that
coordinator's canvas portion, `component-workspace.css`, `canvas.ts`,
`canvas-camera.ts`, and `canvas-culling.ts`; the renderer host and catalog
should not be replaced as part of the first slice.

## Data model and v2 compatibility

The current `ComponentCanvasDocument` v2 remains the persisted interchange
format for the first rollout. A document adapter should:

1. validate and round-trip v2 fields without dropping unknown fields;
2. use stable node IDs, component IDs, preset IDs, scope, bounds, order,
   collapsed state, and camera values as explicit data rather than DOM state;
3. keep renderer session IDs, capability tokens, revisions, and iframe state
   out of the persisted document;
4. represent scene transforms, constraints, and guides as optional v2-compatible
   extensions or a separately versioned in-memory scene envelope; and
5. write only after a validated transaction, retaining the existing size limit
   and project metadata merge behavior.

Scene persistence now uses optional v2-compatible fields without changing the
document version: nodes may carry validated `rotation` and `parentId` values,
and an optional `sizeMode` (`auto` or `fixed`) that records when a user-owned
resize makes persisted width/height authoritative. Omitted `sizeMode` remains
auto for legacy documents. Renderer measurement consumers can use the adapter's
measurement-authority predicate to reject late telemetry for fixed nodes (or
while a resize gesture is active). Ephemeral snap guides may additionally
carry a peer node id and finite cross-artboard segment range; these fields are
runtime geometry only and never enter persisted guide schema.
and the document may carry a bounded `guides` collection with orientation,
position, and locked state. Legacy documents omit these fields and continue to
round-trip unchanged; unknown root, node, presentation, scope, and guide
extensions remain preserved by the adapter. Workspace integration uses the
adapted read/write boundary and commits scene fields through canvas history;
renderer session credentials and source-edit state remain outside the document.

Generated finite variants must carry explicit resolved preset props (or a
stable preset reference that the renderer can resolve); they must not render
with accidental empty/default props. Source undo/redo and canvas history must
remain separate until an explicit transaction bridge is designed.

## Staged scope

### Stage 1 progress

The first pure scene foundation slice is now available beside the existing
canvas: v2 documents preserve unknown extension fields on round-trip;
geometry provides deterministic hit testing, marquee selection, translation,
resize, zoom-aware snapping, and visible guide results; and canvas history
groups a gesture into one bounded transaction with abort rollback. Keyboard
guards and reduced-motion/pinch helpers remain framework-independent. Workspace
and renderer integration is intentionally deferred to later slices. The
workspace now also has an additive `components-canvas/` UI layer: viewport and
world composition, reusable toolbar, selection overlay with resize handles,
pointer-centered camera gestures, middle/Space pan, and empty-space/Shift
marquee selection are wired through `ComponentsWorkspace.tsx` as a compatibility
shell. Renderer host, catalog, persistence, navigation, and command IDs remain
owned by the existing coordinator.

The pure Stage 1 slice now also covers modifier-aware rotation (including
15-degree Shift quantization and explicit Alt center-origin data), deterministic
z-order actions, hierarchy-safe multi-selection and reparenting with
world-position preservation, user guide lifecycle data with guide snapping, and
keyboard shortcut intent mapping that never steals editable-control input.
The focused scene pass now keeps guide snapping deterministic across every
rectangle anchor, honours locked guide lifecycle data, and accepts both
platform redo shortcuts while guarding nested editable targets. These changes
remain pure scene behavior; no workspace, renderer, CSS, or backend contracts
were changed.

### Stage 0 — freeze contracts and preservation

Use the backup listed below, document the v2 fixtures, and freeze command IDs,
navigation shape (`componentId`, `presetId`, `scope`), catalog revisions,
renderer messages, security invariants, and project metadata keys.

### Stage 1 — scene behavior

Add a scene geometry model and transaction history. Implement robust selection
(single, multi, marquee, keyboard), drag, resize handles, snapping/guides,
z-order, and deterministic hit testing. Add cursor-anchored zoom, fit-to-
selection, pan, pinch/touch discrimination, and reduced-motion behavior.

### Stage 2 — rendering and scheduling

Split viewport/world/node rendering, virtualize off-screen nodes, schedule live
iframes within an explicit budget, cancel stale requests, and bound retained
frames. Keep the current sandboxed host, exact-origin checks, capability token,
generation/revision checks, consent gate, and cleanup manifest unchanged.

Stage 2 progress (2026-09-09): the renderer lifecycle now applies the configured
six-frame ceiling to retained live frames and queued requests together. When a
promotion would exceed that ceiling, eviction and cancellation are deterministic,
and late handshakes from evicted requests are rejected. Generated finite variant
nodes retain their explicit resolved matrix props by stable variant ID when frame
payloads are built, rather than falling back to `{}`.

Renderer security progress (2026-09-09): production `RendererFrameHost` events
now pass through a per-host guard that composes the existing exact source/origin,
session, capability-token, generation, frame, and revision validation with whole-
message bounds, event-ID replay rejection, and the bounded message-rate window.
The guard resets its replay/rate state when the negotiated session or generation
changes; iframe sandboxing, consent, and public host props remain unchanged.
The TypeScript bound now measures serialized UTF-8 bytes, and the Rust frame
boundary applies the matching 128 KiB aggregate serialized-message guard while
retaining its field, nesting, and item limits. Publish requests now measure the
full serialized envelope, including session and capability metadata, with
session/auth validation still occurring before the size rejection.

Storage safety progress (2026-09-09): the Rust `component_canvas` read command
now applies the same 512 KiB serialized payload bound as writes and returns the
standard expected `CommandError` before returning an oversized document. Existing
write and project-metadata semantics are unchanged.

Filesystem replacement safety progress (2026-09-09): project metadata writes
and renderer registry/cleanup-manifest staging now use one cross-platform atomic
replacement helper. Unix retains same-directory `rename` replacement; Windows
uses `ReplaceFileW` when the destination already exists and a normal rename only
when it is absent. No delete-then-rename fallback is used, so a failed commit
does not discard either the prior file or its staged replacement. Existing
renderer path/reparse-point validation and temporary-file cleanup remain in
place.

Renderer filesystem safety progress (2026-09-09): generated host installation,
registry/manifest staging, route commits, and manifest cleanup now walk every
existing path component with `symlink_metadata`, reject project-internal
symlinked parents and targets, and verify the deepest existing parent remains
canonically contained by the validated project immediately before each
filesystem mutation. This preserves the lexical route allowlist and
manifest-hash cleanup semantics while preventing `.shipstudio/component-renderer`
and allowed-route parent symlinks from redirecting renderer writes or deletes
outside the project. The checks are repeated around directory creation and
rename operations to narrow races; the path-based standard filesystem API
cannot make the final check-and-mutate step atomic against a separate hostile
process that can concurrently replace project directories (platforms with
`openat`/`O_NOFOLLOW`-style primitives would be required for that stronger
guarantee).

Workspace interaction progress (2026-09-09): drag and resize gestures now own
one canvas-history transaction and Escape aborts back to the exact pre-gesture
document. Rotation is wired through an accessible handle with Shift 15-degree
quantization. Click selection is deferred until a move crosses the drag
threshold, and the canvas context menu opens at the browser invocation point
without starting a pan. Keyboard nudge/delete/duplicate/undo/redo remain
guarded for editable targets; Alt+Left/Right selects a parent/first child when
the adapter has hierarchy data, while bracket navigation selects siblings.

Hierarchy and command reachability progress (2026-09-09): persisted node
coordinates remain parent-local, while rendering, selection chrome, drag/resize,
fit bounds, and snapping project through accumulated world coordinates. The
world projection stops defensively on malformed cycles, and reparenting keeps
the same world position. Multi-selection duplicate/delete now normalizes
ancestor/descendant selections, preserves hierarchy and stable IDs, creates one
history entry, and updates inspector/renderer selection to valid nodes. The
`components.open` command is registered once by the global workspace provider,
so it remains reachable outside the Components workspace; panel toggling and
the Preview-specific `components.openCanvas` command remain separate.

Canvas history integration progress (2026-09-09): all document writes now pass
through one workspace publishing pipeline. Undoable scene commands (including
preset node changes, guide changes, arrange/reset actions, and direct commands)
record labeled entries; gesture updates keep one transaction entry and abort
restores the pre-gesture scene. Camera persistence, renderer measurements, and
catalog/scope reconciliation synchronize the authoritative history state and
rebase those transient fields across existing undo/redo entries without
creating history or erasing prior entries. Loading a project is the explicit
history reset boundary; normal identity drift no longer recreates history.

The workspace now loads through `readAdaptedComponentCanvasDocument` and saves
through the canonical adapted writer, so validated `rotation`, `parentId`,
unknown node extensions, and persisted guides survive reload without entering
renderer/source data. The Layers panel owns scene selection, visibility, locks,
renames, z-order, and cycle-safe reparenting. The workspace now mounts
`ComponentsCanvas` as the single viewport/world runtime surface rather than
duplicating those primitives in the coordinator. A token-styled, screen-space
ruler overlay is now reachable through the Rulers toolbar toggle or Shift+R;
dragging from either ruler creates persisted guides, existing guides can be
moved, focused, selected, or removed with Delete/Backspace, locked guides stay
immutable, and the overlay blocks input while menus or text/edit modes own
focus. Guide mutations use the existing pure guide lifecycle APIs and canvas
history, so they remain undoable and continue to participate in snapping.

Final-audit hardening progress (2026-09-09): project-scoped canvas reads now
carry a cancellation/identity guard and persistence waits for the matching
project hydration, so a late read cannot publish or save into a newly selected
project. Keyboard nudge and resize convert accumulated world coordinates back
to parent-local persistence coordinates. Locked nodes are skipped by keyboard
and z-order/layout mutations; deleting a subtree containing a locked node is
rejected safely rather than stranding that node. Rotated extents are used by
fit bounds and viewport culling, and canvas cards expose `role="option"` with
`aria-selected` for assistive technology without changing iframe interaction.
The remaining rollout work is visual QA and the full repository CI gates; no
renderer, backend, or global command contract was changed in this slice.

Visual polish progress (2026-09-09): the canvas now uses its neutral owner
surface without the heavy grid, artboards are minimal square-corner white
surfaces with selection chrome owned by the screen-space overlay, and resize
affordances keep four visible square corner handles while preserving invisible
edge hit zones and a distinct rotation affordance. Ruler, handle, and
dimension surfaces consume their owner tokens. Whole-canvas auto/reset layouts
reserve logical label clearance at the top and left, and narrow workspaces
relocate the inspector into a compact bottom dock while toolbar groups clip
and scroll independently. Focused overlay and layout tests cover these
contracts; the renderer, backend, and workspace coordinator remain unchanged.

Follow-up hardening (2026-09-09): renderer preparation now carries a
project/version guard across registry install, session creation, source
snapshot, and host install awaits. Switching projects invalidates and clears
stale renderer state, and any late native session is stopped and cleaned up
against its original project. Effective locking now includes locked ancestors
and descendants: movement, keyboard transforms, layout, z-order, duplicate,
delete, and layer reparent drops reject or preserve affected subtrees. Keyboard
nudge normalizes hierarchy roots before converting world coordinates back to
local persistence coordinates. Canvas options now live under a named,
multi-select listbox ancestor.

Layer-lock invariant follow-up (2026-09-09): layer drops now reject every
target that cannot be mutated, including an unlocked container that contains a
locked descendant. Reordering normalizes only movable siblings and leaves
effectively locked nodes' order and parent fields unchanged.

Visual pass progress (2026-09-09): the composed canvas now exposes a
screen-space overlay slot. Selection chrome, dimension badges, marquee, snap
segments, banners, notices, variant controls, and ruler ticks stay stable as
the camera zooms; artboards alone remain in the transformed world. Artboards
use square, minimal outlines with labels above the content, and selection
handles retain large accessible hit areas with restrained square visuals. The
bottom floating control bar keeps zoom, fit, and ruler access reachable.
Resize commits now persist `sizeMode: 'fixed'`, suppress active/fixed renderer
measurements, and no longer add the legacy header-height offset. Remaining
gaps are screenshot-level tuning against the running app and full repository
CI gates.

Visual integration fixes (2026-09-09): screen-space canvas HUDs remain passive
by default while renderer banners, variant actions, and notice dismissals opt
back into pointer input. Rulers and user guides now stay fully inert whenever
an editing modal or context menu blocks canvas interaction. Selected ruler
bands are clipped to the horizontal/vertical ruler strips, and the ruler
geometry uses the token-aligned `CANVAS_RULER_THICKNESS_PX` source matching the
shared `--component-canvas-ruler-thickness` contract rather than a separate
32px assumption. Zoom, fit, and ruler controls now have one owner in the
bottom floating canvas navigation; the workspace header remains reserved for
scope, history, and layout actions.

Visual progress (2026-09-09): the pure `canvas-rulers` helper now projects
bounded major/minor ticks, world-coordinate labels, and selected-range bands
from the camera and viewport geometry. The React ruler overlay remains
unchanged; this helper is intentionally ready for the pending screen-space
visual QA work (labels, selected tint, and endpoint/intersection markers).

### Stage 3 — integration and inspector

Make inspector operations truly multi-selection aware, bridge canvas selection
to catalog/panel navigation, preserve all existing command-palette actions, and
support the existing legacy frames/presets and renderer adapters. Enable live
editing only after its security and acceptance tests pass.

Stage 3 progress (2026-09-09): the additive `CanvasLayersPanel` now provides a
prop-driven, reversed-order layer tree with replace/toggle/range selection,
keyboard navigation, expansion, inline rename, visibility/lock controls, and
caller-owned drag/drop intents (`before`, `after`, and `into`). Tree semantics
report sibling positions correctly, drop thresholds are deterministic, and
hierarchy cycle prevention remains delegated to the scene caller.

### Stage 4 — rollout and hardening

Run fixture-based visual/interaction checks, performance budgets, accessibility
checks, and the repository CI gates. Enable the new canvas by feature flag for
an opt-in project cohort, then expand only after rollback has been exercised.

## Exact acceptance criteria

- Opening, switching, resizing, and closing the Components workspace preserves
  current panel/inset behavior and does not remount unrelated Preview content.
- Existing v2 documents and legacy fixtures load, save, and round-trip without
  loss of known or unknown fields; malformed/oversized data is rejected safely.
- Navigation preserves `{ componentId?, presetId?, scope }`; `focus`,
  `variants`, and `all` remain deterministic and deep-linkable.
- Zoom is anchored to the pointer or documented viewport center; pan, pinch,
  fit, reset, keyboard movement, and reduced-motion behavior do not drift or
  leave nodes unreachable.
- Single selection, multi-selection, marquee, keyboard selection, drag,
  resize, snapping/guides, duplicate, delete, z-order, and escape semantics
  are deterministic and covered by tests.
- Canvas history undoes scene transactions without silently invoking source
  editor undo; redo and persistence are revision-safe.
- Generated finite variants render their resolved props, and preset changes
  invalidate only the affected frames.
- Six initial live frames remain a bounded scheduler budget; retained frames
  are evicted/cancelled deterministically and no unbounded iframe growth occurs.
- Host security tests continue to reject wrong origin, token, generation,
  frame, revision, replay, and unsolicited messages; no project source is
  imported, executed, or injected into Ship Studio.
- Consent, Next adapter/registry behavior, renderer manifest cleanup, and
  project-scoped feature flags remain unchanged at the public contract.
- Existing command IDs (`components.open`, `focusSelected`, `showVariants`,
  `showAll`, `fitCanvas`, `resetZoom`, `resetLayout`, `arrangeAll`,
  `arrangeSelection`, `duplicateSelected`, `deleteSelected`, and renderer
  enable/start/stop/disable actions) continue to work through Cmd+K.
- Accessibility inspection through the iframe bridge remains available, and
  keyboard/focus behavior is usable without pointer input.
- Targeted canvas/renderer tests pass, followed by `pnpm check:all`,
  `pnpm test:run`, and `pnpm rust:test` before declaring the migration done.

## Explicit non-goals

Do not copy Grida's runtime, scene engine, DOM/markup, CSS, design language,
branding, logos, or trademarked UI identity. Do not import user project code
into the Ship Studio process, weaken iframe sandboxing or consent, broaden
renderer allowlists, or add unsupported framework adapters as part of this
migration. Do not replace the catalog/source worker, Tauri command contracts,
or shared UI primitives merely to match an external implementation. Do not
perform a wholesale rewrite of unrelated workspace panels.

## License and trademark note

The pinned Grida commit is a behavioral reference only. This plan selects an
independent implementation and therefore does not copy Grida source. If a
future change copies any code or non-trivial snippet, review its license at the
exact commit, retain the required Apache-2.0 attribution and modification
notice, and record the copied files in the notices. Do not use “Grida” in
Ship Studio product UI, logos, or marketing in a way that implies affiliation;
use “Grida-like behavior” only as an internal engineering description.

## Unknowns and decisions to resolve

- Decide whether persisted scene extensions remain v2 fields or move to a v3
  envelope, and define one-way migration plus downgrade behavior.
- Define rotation, constraints, auto-layout, snapping tolerance, and guide
  semantics before implementing handles; these are not inferred from the
  current card board.
- Choose iframe retention and frame-budget policy that works for large catalogs
  without changing the host security contract.
- Decide how selection synchronization behaves when a catalog revision removes
  or renames a component/preset.
- Decide whether source and canvas history ever share a transaction boundary;
  default is separate histories.
- Add compare-and-swap/revision handling for backend metadata writes if
  concurrent project windows are supported.
- Define the live-editing message protocol and threat model before enabling the
  currently disabled editing flag.

## Rollout and rollback

Introduce the new scene modules behind a project-scoped feature flag while the
current workspace remains a compatibility shell. Migrate reads first, validate
and shadow-render without changing persistence, then opt in writes only after
v2 round-trip and security checks pass. Keep the old implementation and
contracts available through at least one release; rollback means disabling the
flag and reopening the existing canvas document, not deleting or rewriting it.

Never reset, clean, or overwrite a dirty worktree during rollout. Before each
milestone, make a new external snapshot and record the migration commit. If a
schema or renderer regression occurs, restore tracked changes with the binary
patch and selectively copy untracked files from the snapshot after reviewing
the destination status.

## Preservation backup

The pre-migration snapshot is:

`/Users/martincrandon/Desktop/Development/Ship Studio/ship-studio-maintainer-backups/canvas-pre-grida-20260908T233420Z/`

Its `README.md` documents the manifest and non-destructive restore procedure.
The repository's dirty branch, exact `HEAD`, status, binary diff, untracked
list, current implementation copies, renderer fixtures, and deleted `HEAD`
references were verified there without changing the worktree.

## Persistence ordering hardening (2026-09-09)

User-authored canvas history entries and committed drag/resize/rotation
transactions now enqueue an immediate project-scoped write. This closes the
180 ms debounce window during workspace switches, unmounts, and close flows;
camera and renderer-measurement updates retain the debounce because they are
transient. The canvas storage boundary serializes writes per project and
exposes a cleanup flush, so an older asynchronous metadata write cannot finish
after a newer geometry write and overwrite it. Project-keyed queues also keep
old-project writes isolated from the newly selected project. Deferred IPC tests
cover fixed resize persistence, ordering, and project isolation; undo/redo uses
the same committed-write path.

## Canvas interaction safety hardening (2026-09-09)

The optional backend `component_canvas` value `null`/`undefined` is now treated
as a fresh document, while malformed non-null payloads remain unreadable and
protected from overwrite. Regression coverage proves the first edit in a fresh
project reaches project metadata storage.

Active drag, resize, and rotation transactions suspend geometry debounce. Both
commit and Escape/unmount rollback write the authoritative settled document
immediately; camera and renderer updates outside gestures remain debounced.
Z-order actions now reuse movable order slots so effectively locked nodes keep
their persisted `order` and immutable layer slots.

Canvas ordering and layout progress (2026-09-09): persisted node order now
drives deterministic hierarchy-aware paint order (including culled/live nodes),
with selection HUD above the world and the reversed layer-tree order preserved.
Canvas Cmd/Ctrl undo and redo stay separate from source snapshots while
editable controls retain native text undo; explicit canvas history buttons and
palette commands are available. Arrange All/Selection now lays out only
normalized hierarchy roots, preserving descendant parent-local geometry and
locked subtrees.

## Project metadata write serialization (2026-09-09)

All backend read-modify-write paths for `.shipstudio/project.json` now use a
short-lived, per-project serialization lock. Canvas documents, terminal state,
`last_opened`, publish records, health results, dev-server/UI settings, Git
lineage/stash state, assets, Shopify settings, renderer consent, thumbnails,
and workspace tags therefore merge against the latest on-disk metadata instead
of replacing unrelated fields from a stale read. Metadata replacement writes a
same-directory temporary file and renames it atomically, so readers do not see
partial JSON. The lock covers only metadata I/O and in-memory mutation; slow
Git, renderer, and other unrelated work remains outside it.

## Project-switch canvas hydration safety (2026-09-09)

The Components workspace now closes its canvas interaction gate in the render
that observes a new project path. Until the identity-checked document read
completes, the prior scene is removed from the DOM and replaced with an
accessible, project-scoped loading state. Pointer, keyboard, context-menu,
toolbar, layer, guide, renderer telemetry, and renderer setup callbacks fail
closed during this interval, including stale camera/gesture publishes. A
matching readable document reopens the gate; malformed or failed reads remain
read-only and cannot overwrite the loaded project. Renderer stop and cleanup
continue through their independent project-switch cancellation path, using the
captured owning project path and session identity. Project changes also cancel
camera animation/RAF work, clear pending camera state, release pointer capture,
and leave old gesture rollback with the old project cleanup boundary. Deferred
hydration tests cover rejected stale inputs, canceled transient work, and
unreadable read-only state.

## Grida-reference title, hit-testing, and ruler parity (2026-09-09)

The independent canvas adapter now follows the pinned Grida surface contracts
for these interactions: one DOM-owned title per visible artboard, camera-
projected screen positioning with constant typography and gap, modifier-safe
double-click inline rename, and a transparent artboard hit surface that owns
selection/movement unless explicit renderer edit mode grants the iframe input.
The prior world-space title owner was removed, eliminating duplicate and
zoom-rasterized labels while keeping rename history synchronized with Layers.

Rulers are now thin viewport-space strips with adaptive sparse world-coordinate
labels, restrained major/minor ticks, negative coordinates, a clean corner,
and no repeated checker background. Selection bounds paint pale-blue axis
ranges with blue start/end ticks and coordinate labels; their projection
updates from the authoritative document throughout drag/resize/rotation and
settles or rolls back with the existing transaction. Guide creation, locking,
snapping, Ctrl bypass, hydration blocking, and the iframe security boundary are
unchanged.
