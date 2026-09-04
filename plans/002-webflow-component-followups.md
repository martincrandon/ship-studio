# 002 — Native Components reliability and Webflow-parity follow-ups

> **Executor instructions**: Read `CLAUDE.md` and this document completely
> before editing. Preserve Ship Studio's source-authoritative, fail-closed
> component model. Treat the five product deliveries as separately reviewable
> slices. Run only focused verification while iterating, and ask the operator
> before running `pnpm check:all`, `pnpm test:run`, or `pnpm rust:test`.
>
> **Drift check**: `git diff --stat 30e252ca..HEAD -- src src-tauri docs plans`
> and `git status --short`. The working tree already contained uncommitted
> Element Tree/focus presentation changes when this plan was written. Preserve
> them and do not reset, overwrite, or fold them into unrelated work.

## Status

- **Priority**: P0 reliability fixes, followed by P1/P2 product deliveries
- **Effort**: XL, split into independently reviewable deliveries
- **Risk**: HIGH
- **Depends on**: `plans/001-native-components.md`
- **Category**: correctness, tech debt, tests, and direction
- **Planned at**: commit `30e252ca`, 2026-09-04
- **Implementation status**: PAUSED — continuation-ready checkpoint recorded below

## Progress checkpoint — 2026-09-04

Three Luna/xhigh executor tracks completed coherent source-safe slices and then
stopped at the operator's requested handoff point. The combined worktree
currently passes `pnpm typecheck` and `git diff --check`. Executors also report
the following focused verification: Canvas/QA/presets/panel (24 tests),
Properties/Slots/component adapters (43 tests), and reliability/library/worker
coverage (focused availability, lifecycle, package, worker, and library tests;
the final library run contains 5 tests). No long repository-wide suite was run.

Implemented in the current uncommitted worktree:

- [x] Supported web project types can reach the component catalog instead of
      being restricted to Next.js and React-flavoured Vite.
- [x] Stateful component-worker requests are serialized and host snapshot/index
      refs publish only for the latest refresh generation.
- [x] Watcher startup cleans itself up when disposal wins the async race.
- [x] Exact instance props support source-backed reset/removal, including
      tri-state optional booleans, across React, Astro, and markup adapters.
- [x] Direct source-proven component children are projected into slot metadata;
      guarded insert/remove/reorder planners and a visible advanced-source
      fallback exist.
- [x] A Component Canvas UI, Cmd+K entry, project-scoped named frames, finite
      variant choices, frame management, explicit props/static slots, source
      navigation, and orphan visibility exist.
- [x] Canvas frames remain metadata-only because no adapter currently proves
      isolated rendering. Hard-coded breakpoint/locale assumptions were removed;
      the UI accepts only verified host-provided choices and otherwise offers
      Follow preview / Default locale.
- [x] Revision-bound QA baseline/diff, bounded matrix, uncovered-variant, a11y
      result, and bounded agent-handoff models exist with focused tests.
- [x] Bounded workspace-package/library discovery and a conservative local-fork
      planner exist. Fork renames and relative dependency closures fail closed.

Highest-priority continuation work:

- [ ] Add safe isolated-renderer host capability; until then screenshots,
      actual visual diffs, automated a11y, and rendered variant frames remain
      disabled.
- [ ] Wire structured slot insert/remove/reorder planners into user-facing
      Element Tree/preview controls; the current UI only exposes proven child
      navigation plus the raw-source fallback.
- [ ] Complete Properties 2.0 beyond reset: optional placement props, asset
      picker, richer static controls, metadata groups/tooltips, and reviewed
      suggested props.
- [ ] Integrate libraries into catalog grouping, read-only ownership UI,
      reviewed fork/apply flow, update diffs, and Cmd+K.
- [ ] Add full cross-dialect panel integration tests and update
      `docs/internal/components.md` to distinguish implemented models/planners
      from user-facing and renderer-backed capability.
- [ ] After completing the remaining UI integrations, obtain operator approval
      and run `pnpm check:all`, `pnpm test:run`, and `pnpm rust:test`.

## Why this matters

The native Components foundation has unusually strong safety properties:
immutable source graphs, exact UTF-8 ranges, hash-checked writes, reviewed
multi-file refactors, runtime/source confidence levels, and fail-closed
behavior when identity is ambiguous. It already maps Webflow's distinction
between a main component, an instance, props, slots, and in-context main
editing without replacing framework-native source.

However, the live integration does not yet expose most implemented adapters,
has two lifecycle concurrency hazards, cannot restore an instance prop to its
default/unset state, and contains preview-preset infrastructure without a
user-facing workflow. Product-wise, the panel is currently closer to a safe
component catalog/refactor browser than a complete design-system editor.

Webflow's current component surface includes instance properties and slots,
style/layout variants, a dedicated Component Canvas with variants side by
side, suggested/grouped properties, conditional behavior, dynamic attributes,
and shared/code component libraries. Ship Studio should adopt the useful
interaction patterns while retaining native source as the authority and never
inventing routes, defaults, contracts, or runtime identity.

Primary references:

- [Webflow Components overview](https://help.webflow.com/hc/en-us/articles/33961303934611-Components-overview)
- [Webflow Component Canvas](https://help.webflow.com/hc/en-us/articles/49505240420755-Component-canvas)
- [Webflow component properties](https://help.webflow.com/hc/en-us/articles/33961219350547-Component-properties)
- [Webflow Libraries](https://help.webflow.com/hc/en-us/articles/33961343551763-Libraries)
- [Webflow dynamic attributes](https://webflow.com/updates/dynamic-attributes-for-components)

## Non-negotiable invariants

- [x] Source code and native framework semantics remain authoritative.
- [x] No project component module, framework configuration, or arbitrary build
      code is executed to construct the catalog.
- [x] No route, default prop, variant, preview, usage, or library state is
      fabricated when it was not explicitly parsed, returned, or saved.
- [x] Every source write remains path-validated, revision/hash-checked,
      parser-validated, transactional where multi-file, and fail-closed.
- [x] Read-only indexing, source mutation, runtime binding, focused visual
      editing, isolated preview, and library ownership remain separate
      capabilities.
- [x] Dynamic or ambiguous source is surfaced as read-only with a diagnostic.
- [ ] All new user-facing actions are registered with `useCommands`.
- [x] UI uses shared primitives and design-token-only CSS.
- [ ] New Rust commands use `Result<T, CommandError>`,
      `validate_project_path()`, bounded execution where applicable, and
      `#[tracing::instrument]`.

## Reliability findings to fix first

### P0 — Expose every implemented adapter through a capability-driven gate

Current evidence:

- `src/hooks/useComponentsAvailability.ts:5-33` still returns true only for
  Next.js and React-flavoured Vite.
- `src/components/workspace/WorkspaceView.tsx:753-764` uses that result to
  decide whether the Components panel can exist.
- `docs/internal/components.md:8-19` describes Astro, Vue, Svelte, Shopify,
  Web Components, React Native, and Flutter support at their distinct
  capability levels.

Checklist:

- [x] Replace the stale React-only availability gate with a capability-driven
      result derived from reliable project/index detection.
- [x] Make the catalog reachable for Astro, Nuxt/Vue, SvelteKit/Svelte,
      Shopify, and eligible Web Component projects.
- [x] Preserve source-only behavior for mobile dialects and read-only behavior
      wherever a runtime/write capability is false.
- [ ] Add integration tests proving panel reachability and correct disabled
      actions for every advertised dialect.
- [x] Remove the stale "React is the first native Components adapter" comment.

### P0 — Serialize or generation-bind catalog worker refreshes

Current evidence:

- `src/hooks/useComponentCatalog.ts:214-299` sequences snapshot loads, but
  assigns `snapshotRef.current` before its final supersession check and does not
  cancel worker work.
- `src/lib/components/component-worker.ts:32-39` owns shared mutable active
  snapshot/index/store state.
- `src/lib/components/component-worker.ts:327-333` starts each async message
  handler without serializing stateful build/update requests.
- Astro validation adds an asynchronous parse boundary at
  `src/lib/components/component-worker.ts:290-301`.

Checklist:

- [x] Give every catalog generation an explicit identity or serialize all
      state-mutating worker requests.
- [x] Prevent a superseded build/update from changing the worker's active
      snapshot, index, or store.
- [x] Move all host ref assignments behind the final current-generation check.
- [x] Ensure bind and mutation planning target the same generation published
      by the host.
- [x] Add deterministic overlapping-refresh tests, including an Astro-delayed
      older request resolving after a newer request.

### P1 — Support resetting/removing an instance prop

Current evidence:

- `src/components/edit/ComponentInstanceControls.tsx:224-260` renders an
  `Unset` option but ignores the decoded `null` value.
- Optional booleans visually conflate an absent prop with explicit `false`.
- `src/lib/components/types.ts:683-689` models prop editing only as setting a
  `StaticValue`; it has no remove/reset operation.

Checklist:

- [x] Replace the set-only contract with an explicit `set | remove` operation.
- [x] Implement exact static attribute/prop removal in each adapter that
      advertises the capability.
- [x] Present optional booleans as Default / True / False rather than a
      two-state checkbox.
- [x] Make text, number, asset, and choice controls distinguish empty values
      from absent/default values.
- [x] Add parser, worker, hook, and UI tests for reset-to-default and no-op,
      stale, dynamic, spread, and required-prop refusal cases.

### P1 — Complete or honestly reclassify preview presets

Current evidence:

- `src/lib/components/presets.ts` implements versioned parsing, persistence,
  and reconciliation.
- Outside its unit test, the preset API has no UI/runtime consumer.
- All current adapters publish `isolatedPreview: false`.
- `docs/internal/components.md:74-82` describes the persistence contract as an
  implemented capability.

Checklist:

- [x] Integrate preset creation, naming, editing, deletion, selection, and
      orphan recovery into the product as part of Delivery 1 below.
- [x] Persist presentation metadata in the appropriate project-scoped store;
      do not allow presets from one project to bleed into another project with
      coincidentally equal component IDs.
- [x] If isolated rendering is not safely available for a dialect, show the
      preset as metadata/read-only rather than claiming a rendered preview.
- [ ] Update the support matrix so it precisely distinguishes persistence
      helpers from a usable preview workflow.

### P2 — Close the watcher-start cleanup race

Current evidence:

- `src/hooks/useComponentCatalog.ts:328-371` checks disposal after listener
  registration but not after awaiting `startComponentSourceWatch`.
- The backend replaces a watcher when the same window starts another project,
  limiting impact, but a late start can remain active until project/window
  teardown.

Checklist:

- [x] If disposal occurs while watcher startup is pending, stop the watcher as
      soon as startup resolves.
- [x] Ensure cleanup remains safe when a newer project watcher has already
      replaced the old one.
- [x] Add a hook test with a deferred start promise and cleanup-before-resolve.

## Product Delivery 1 — Component Canvas and variant matrix

This is the highest-value major addition. Reuse the existing component index,
`variantProps`, preset schema, preview bridge, responsive controls, locale
switcher, screenshots, and source navigation.

Checklist:

- [x] Add an isolated Component Canvas entry point from the Components panel,
      an exact instance, and Cmd+K.
- [ ] Render explicit named preset frames without executing component modules
      inside Ship Studio's own process.
- [x] Derive selectable variant choices only from literal unions, enums,
      Shopify choices, or explicit saved metadata.
- [x] Let users add/remove/reorder frames and configure explicit props/slots.
- [x] Support Fit, Full, and explicit fixed frame widths, safe height choices,
      background, breakpoint, and locale.
- [x] Show multiple selected variants side by side with bounded pan/zoom.
- [ ] Apply Edit main changes to the proven definition and visibly refresh all
      affected frames.
- [x] Navigate from a frame to source and, where one exists, to a real usage.
- [x] Never automatically create an unbounded Cartesian product of variant
      props; require explicit frame selection and enforce a documented cap.
- [x] Reconcile renamed/deleted props and components as visible orphaned
      presets rather than silently retargeting them.
- [ ] Add focused canvas/preset/frame tests and document each dialect's
      isolated-preview capability.

## Product Delivery 2 — Properties 2.0

Turn the current metadata list and exact-instance controls into a complete
source-backed property workflow while preserving explicit contracts.

Checklist:

- [ ] Allow users to configure optional as well as required props before
      placement.
- [x] Include the reset/remove-to-default behavior from the P1 fix above.
- [ ] Reuse the Assets panel picker for image/file props instead of a raw path
      field.
- [ ] Add reliable controls for URL/link, rich text, class, attribute-object,
      nullable, array, and object values when their static source form is
      provable.
- [ ] Read descriptions/tooltips from JSDoc, framework schema, or explicit
      component metadata; never invent descriptions.
- [ ] Store property groups and presentation ordering as explicit companion
      metadata when the framework source does not represent them.
- [ ] During extraction, offer reviewed "suggested props" only for provable
      selected text, links, images, visibility, and attributes.
- [ ] Allow users to accept, rename, or reject each suggested prop before the
      source transform is planned.
- [x] Keep dynamic expressions read-only with direct source navigation.
- [x] Add tests for every new control and each framework-specific serializer.

## Product Delivery 3 — Structured slot composition

The current exact static slot textarea remains a useful source fallback, but
the primary workflow should make composable structure visible.

Checklist:

- [ ] Project proven slots as consistently named drop zones in the Element
      Tree and preview.
- [ ] Allow placing an existing indexed component into a statically proven
      slot through the same reviewed source-mutation pipeline.
- [ ] Allow reordering and removing exact static slot children.
- [ ] Support nested component focus and Edit main directly inside a slot.
- [ ] Support optional allowed-component restrictions only from explicit
      framework types or saved metadata.
- [x] Preserve the raw source editor as a clearly labelled advanced fallback.
- [x] Refuse dynamic slot names, scoped/control-flow slot bodies, spreads, and
      runtime-generated children with actionable diagnostics.
- [ ] Add nested, empty, named/default, restricted, stale, and dynamic slot
      tests across supported adapters.

## Product Delivery 4 — Component QA workflows

Use the Component Canvas as the shared rendering surface rather than creating
a separate testing product. This is the main opportunity to exceed Webflow's
component workflow using Ship Studio's agent, preview, screenshot, breakpoint,
locale, and source-hash infrastructure.

Checklist:

- [ ] Capture an explicit visual baseline for each selected preset/frame.
- [ ] Compare the current render with its saved baseline and present a useful
      diff with threshold metadata.
- [ ] Run accessibility checks per frame and associate findings with the
      component, preset, and current source revision.
- [ ] Batch a bounded, user-selected matrix of breakpoints and locales.
- [x] Report uncovered finite variant choices and orphaned presets without
      fabricating coverage requirements.
- [x] Add an action that sends the failing frame's screenshot, explicit props,
      source definition, and diagnostic context to the active coding agent.
- [x] Exclude source text, absolute paths, prop values, screenshots, and other
      potentially sensitive component data from analytics.
- [x] Add deterministic tests for baseline identity, diff state, a11y results,
      matrix caps, stale revisions, and agent payload boundaries.

## Product Delivery 5 — Code-native shared libraries

Model libraries around real packages and repositories, not copied opaque
component objects. Extend the existing internal-package source resolution and
attached-library concepts only through explicit, validated ownership rules.

Checklist:

- [x] Detect eligible workspace/npm packages that explicitly export indexed
      components.
- [ ] Group the catalog into Project Components and Library Components by
      reliable package/source identity.
- [ ] Keep library definitions read-only in consumer projects unless the user
      opens the owning source project.
- [ ] Display only known package version, source repository, and ownership
      metadata.
- [ ] Provide reviewed library-update diffs including component contract,
      token, asset, font, and removed/renamed export changes where known.
- [ ] Offer "copy/fork to project" with collision detection and a reviewed
      source/import plan; copied components stop receiving library updates.
- [ ] Provide explicit accept/defer behavior for dependency-backed updates;
      never rewrite a dependency or lockfile without a reviewed plan.
- [x] Prevent library source outside the validated project/package boundary
      from entering mutation commands.
- [x] Add package-alias, monorepo, version-change, removed-export, collision,
      read-only ownership, and fork-local tests.
- [ ] Document unsupported package managers, remote registries, framework
      transforms, and update semantics instead of guessing.

## Deferred lower-priority completeness

- [ ] Add exact dev-runtime bindings for Vue and Svelte when their supported
      tooling can provide hash-bound definition and invocation provenance.
- [ ] Add conservative support for default exports, barrel re-exports, aliases,
      shared multi-component files, and file-move refactors.
- [ ] Add lifecycle refactors for non-React adapters one proven operation at a
      time.
- [ ] Add conditional visibility helpers backed by explicit boolean/variant
      props and proven source transforms.
- [ ] Add dynamic `aria-*`, `data-*`, analytics, class, and structured-data
      attribute editing from explicit contracts.
- [ ] Do not prioritize general DOM-to-component conversion, arbitrary dynamic
      expression rewriting, or claims of universal framework parity.

## Commands and verification

| Purpose | Command | Expected result |
| --- | --- | --- |
| Type safety | `pnpm typecheck` | exit 0, no TypeScript errors |
| Focused UI | `pnpm exec vitest run <changed-test-files>` | all selected tests pass |
| Focused Rust | `cd src-tauri && cargo test <focused-filter>` | selected tests pass |
| Formatting | `pnpm format:check` and `pnpm rust:fmt:check` | exit 0 |
| Patterns | `pnpm check:patterns` | exit 0 |
| Full CI, only after approval | `pnpm check:all && pnpm test:run && pnpm rust:test` | all gates pass |

## Done criteria

- [ ] Every reliability finding is fixed with a focused regression test.
- [ ] All five product deliveries have user-facing flows, capability gates,
      Cmd+K actions, documentation, and focused tests.
- [ ] Unsupported dialects and dynamic cases remain visible but read-only.
- [ ] No product path treats a source-only usage as a proven rendered runtime
      boundary.
- [ ] No unbounded variant matrix, source scan, library traversal, screenshot
      batch, or agent payload is introduced.
- [x] `pnpm typecheck` passes.
- [ ] Focused frontend and Rust tests for changed areas pass.
- [ ] The operator has approved and the final executor has run the repository's
      three long CI gates before the work is declared complete.

## STOP conditions

Stop and report rather than improvising if:

- A delivery requires executing arbitrary project modules or framework config
  inside Ship Studio to discover a component contract.
- Reliable isolated rendering requires modifying the user's project without an
  explicit reviewed instrumentation step and cleanup contract.
- A library source cannot be kept inside a validated ownership/path boundary.
- A proposed adapter cannot preserve exact byte ranges and validate its
  post-edit syntax.
- Changes from another executor overlap the same symbols and cannot be merged
  without discarding user or executor work.
- A focused verification command fails twice after a reasonable correction.

## Audit and verification baseline

The audit covered the native Components source/index/worker/hooks/panel,
workspace availability gate, Element Tree integration, mutation contracts,
internal documentation, and current Webflow component documentation. It did
not audit unrelated Ship Studio features or perform live native-device testing.

At plan creation, the current working tree passed `pnpm typecheck` and
`pnpm exec vitest run src/components/edit/ComponentsPanel.test.tsx` (11 tests).
The long frontend and Rust suites were not run because `AGENTS.md` requires
operator approval.
