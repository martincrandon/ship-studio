# Implementation Plans

This repository copy tracks implementation evidence for the plans that are
being executed against Ship Studio. Keep each plan's checkboxes synchronized
with focused verification; `DONE` means every acceptance criterion and final
gate has actually passed.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---:|---:|---|---|
| [001](001-native-components.md) | Add code-native Components to Ship Studio | P1 | L | — | DONE |
| [002](002-mobile-components-runtime.md) | Mobile component runtime integrations | P1 | M | 001 | DONE |
| [003](003-component-canvas-element-editing.md) | Make a selected component frame the Components canvas editing surface | P1 | L | 001 | IN PROGRESS |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED` (with a one-line
reason), or `REJECTED` (with a one-line rationale).

Plan 001 is implemented as separately reviewable slices in one working branch
for this development session. Do not mark it `DONE` until the plan's
operator-approved full repository gates and packaged worker smoke check are
complete.

Plan 003 is a descendant-inspection and Edit-main extension of the web component
renderer delivered by Plan 001. It must land for the reviewed Next App/Pages
hosts before equivalent behavior is attempted in the mobile runtimes from Plan
002; mobile previews do not expose a DOM and cannot reuse this protocol.
