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

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED` (with a one-line
reason), or `REJECTED` (with a one-line rationale).

Plan 001 is implemented as separately reviewable slices in one working branch
for this development session. Do not mark it `DONE` until the plan's
operator-approved full repository gates and packaged worker smoke check are
complete.
