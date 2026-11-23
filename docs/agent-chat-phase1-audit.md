# Agent Chat Phase 1 handoff audit

Audit scope: terminal-backed “send to agent” prompts, queued prompt handoffs, Agent panel view preferences, interactive request behavior, and Cmd+K reset/Agent Settings access. Chat runtime, store, provider, and persistence implementation are treated as the baseline; this audit does not modify those implementations, Rust, or `docs/agent-chat.md`.

## Routing contract

`App.tsx` routes the shared `sendToClaude` path according to the active project’s Agent panel view. In Chat, it calls the existing `stagePrompt(projectPath, text)` for the selected draft/thread and returns `chat-draft`; this does not call a Chat send function. If the Chat target is unavailable, it reports that and does not fall through to a hidden Terminal. In Terminal, it uses the existing active-terminal paste path and returns `terminal`. This leaves Claude Code, Codex Terminal, OpenCode, Cursor, and other terminal providers on their existing Terminal path whenever Terminal is selected.

Handoff success notices that previously implied a prompt was already sent now distinguish a staged Chat draft from text pasted into a Terminal input. Terminal prompts still require Enter; Chat prompts require the user to review and press Send.

## Caller audit

| Caller or entry point | Concrete path | Result |
| --- | --- | --- |
| Code selection, browser tools, inspect/log entries, device build/setup, branch conflict and review actions, Git error recovery, Shopify setup/commands, Languages prompt review, preview/dev-server recovery prompts | Feature callback → `WorkspaceView.sendToClaude` → `useProjectLifecycle.sendToClaude` → `App.pasteToSelectedAgent` | Stages in the selected Chat draft when Chat is active; otherwise uses the active Terminal. Success feedback names the selected destination, and Chat staging reveals the panel for review. |
| Canvas comment handoff | `useWorkspaceComments` → `useTeamWorkspace.sendToAgent`; its `CommentAgent.send` implementation is `lib/commentAgents.ts` → `TerminalHandle.pastePrompt` | Chat stages the project-bound comment prompt only when the selected Chat target uses the Preview project checkout. Otherwise it reports why and keeps the comment selection pending. Terminal still sends to the selected terminal tab and keeps the existing provider choice. |
| Inbox “Fix in project”, project creation migration, and migration fidelity handoff | `InboxView` / `useProjectCreation` / `FidelityPanel` → `queueHandoff` → `useFindingHandoff` / `useWorkflowHandoff` | Queue changes are observable even when the workspace is already open. Chat stages into the selected project checkout, reveals the panel, and reports that the user must review and Send. Terminal keeps the new-tab `initialPrompt` behavior. A mismatched Chat checkout is reported and never redirected into a hidden Terminal. Terminal capacity does not block a Chat draft. |
| Preview screenshots, crop, and full-page captures | `useScreenshotManagement.resolveCaptureDestination` → `getAgentChatCaptureTarget` → `stageCapturedAttachment` | Existing Chat capture target is resolved at capture initiation and remains tied to its project/thread/draft/checkout through async capture. Terminal captures retain the saved-path paste route. No capture integration was changed. |
| Raw PTY input | `Terminal.tsx`, `BuildTerminal.tsx`, and the device build session | These are terminal keystrokes, build-session input, or a device reload key, not user-facing prompt handoffs. They remain bound to their own PTY and are not routed into Chat. |
| `AgentBridgeContext.sendToAgent` | Context implementation and Terminal writer registration | A repository-wide call-site search found no production consumer of `sendToAgent`; no feature handoff is currently bypassing the shared route through this context. |
| Setup/onboarding agent prompts | Setup terminal components and onboarding prompt helpers | These run outside an open workspace’s Chat/Terminal view choice and remain in the existing setup flow. |

## Accepted handoffs and preserved content

`CodeViewer` now calls the shared route before recording `code_snippet_sent_to_agent`. A `false` result returns immediately, leaving the selected code and typed question in the popover. For an accepted Terminal paste or Chat draft, it records the event, shows the destination-specific success notice, and clears the popover. Chat remains a staged draft for review and an explicit Send.

`BrowserTools` likewise records `browser_tools_sent_to_agent` only after the route accepts the prompt. A rejected handoff leaves the captured inspector entries available; this view does not clear them on either path.

`Preview.tsx` now reports the success notice and `preview_fix_with_agent` event only when the shared route accepts the prompt. On `false`, it returns without either effect; the shared route retains its visible failure notice.

`MergeConflictModal.tsx` keeps the dialog open when an available agent route returns `false`, leaving its prompt and actions in place while the shared route displays the failure. It does not run the clipboard fallback on a rejected route. It reports route success only after acceptance. When no route handler is available, **Copy & Fix** remains a clipboard fallback: it waits for the copy result, closes with a success notice only after a confirmed copy, and leaves the dialog open with an error notice if copying fails. Chat staging continues to ask the user to review the draft and press Send.

Nearby caller checks found that `DevServerLogs`, `ConflictResolutionModal`, `SubmitReviewModal`, `GitErrorHandler`, and `LanguagesModal` already stop before analytics or UI cleanup when the route returns `false`. `DeviceMirror` and Shopify prompt callers use the shared success-message helper, which suppresses success notices on `false`, and do not discard user-entered state on this path. `CodeViewer` and `BrowserTools` return before analytics and cleanup on `false`.

The repository-wide direct-writer search found no additional handoff bypass. The preview's server-error overlay has its own explicit **Send to Claude** button and routes through the same selected-surface callback; it leaves the overlay in place and adds no local success effect. `lib/commentAgents.ts` remains the canvas-comment adapter: Chat stages only after matching the comment project checkout, and Terminal uses the selected terminal’s `pastePrompt` acknowledgement before clearing the selected comments. The other `writePtySession*` calls are terminal/build/device input. `AgentBridgeContext.sendToAgent` has no production call site. The final caller inventory found no remaining route-rejection path that records accepted-handoff analytics, shows a success notice, clears its prompt content, or closes its action context.

## Interactive request behavior

The Chat request card supports approval decisions offered by the provider and `item/tool/requestUserInput` questions with the returned option or text fields. Unsupported approval shapes and unsupported question formats are shown as such; the UI does not invent a response. MCP elicitation requests are recognized, but schema-based interactive forms are not implemented: the card clearly says the form cannot be completed in Chat and offers only **Cancel request** or **Decline**. It does not submit an accepted form response. This is an explicit unsupported path, not a supported schema-form flow.

## View preference regression coverage

`src/lib/agentChatPreferences.test.tsx` exercises the current hook contract: Terminal is the initial default, an explicit project choice overrides the Experimental default, **Use default** removes that override, and changing the global default updates the preference without switching an already-open project. Reopening then uses the new default.

## Cmd+K actions

`useAgentChatCommands` registers **Reset Chat conversation**, available only in project context when a Chat thread is selected. It captures that thread ID and uses the shared `ProjectActionConfirmModal`; no discard command runs before the user confirms. It also registers **Agent Settings: notification sounds** in project context and **Toggle Agent auto-accept** only when the active Chat provider or selected Terminal provider supports that flag. The existing auto-accept handler retains its confirmation before enabling the mode. **Show Agent Chat**, **Show Agent Terminal**, **Focus Agent Chat**, **New Chat conversation**, and **Stop current Chat turn** are also in this hook. Skills, MCP servers, Plugin manager, and Help are already registered in the shared `useAppCommands`; they are not duplicated.

The Agent Settings dropdown also remains intact in both Chat and Terminal views.

## Evidence and remaining gaps

The audit used repository-wide searches for PTY writes, `pastePrompt`, `sendToClaude`, `onSendToAgent`, `queueHandoff`, and initial prompts, then traced each caller through its actual callback. No Phase 1 caller was found that automatically submits a Chat prompt or falls back to a hidden Terminal. Migration fidelity can queue while a workspace is already mounted, so the queue publishes revisions and the handoff hook observes them instead of only checking once at mount.

## Review follow-up

Reviewed the Phase 1 integration diffs in `App.tsx`, `useWorkflowHandoff`, `workflowHandoff`, `useTeamWorkspace`, `useWorkspaceComments`, `useAgentChatWorkspace`, `useAgentChatCommands`, and the prompt callback callers.

- The shared route stages into the currently selected Chat draft and reveals Chat for review. A missing Chat target returns failure with an explanatory toast and never falls through to Terminal. Terminal remains the route when Terminal is selected; when its active terminal ref is unavailable, the caller now gets a visible failure instead of a silent `false`.
- The handoff queue's revision subscription rechecks a newly queued prompt in an already-mounted workspace. Each attempt reads only the active project's queued record; stage/spawn and `consumeHandoff()` happen synchronously in the same attempt, and the notification after consumption causes the next effect to see an empty queue. No duplicate delivery or cross-project delivery path was found in this review.
- Canvas comment delivery checks the selected Chat target's checkout against the Preview project before staging. That Chat path has no async gap between checking and staging. Terminal comment adapters capture the workspace project path and terminal tab id, resolve the matching `projectPath::tabId` ref, and clear selection only after that terminal acknowledges the paste and only if the same project and selected thread IDs are still current. A late completion cannot clear selections made after a project or selection change. The sending indicator is also keyed to project path, so an old send cannot clear a newer project's in-progress state. Failures leave comments selected.
- Reset confirmation already captured the selected project/thread, but its async-state callback previously read the latest rendered project path. It now passes the captured project path and thread id into deletion explicitly. Confirmation text now states that the saved Ship Studio conversation, draft, and Ship Studio-owned attachments are permanently deleted while Codex provider history is retained.
- A `false` handoff result previously let several callbacks close their UI or clear typed input anyway. The Languages prompt review, merge conflict handoff, Git error handoff, PR conflict handoff, and dev-log selection now stay available on failure. PR and log-delivery analytics are recorded only after the route accepted the prompt.

The earlier review recorded a passing `useAgentChatCommands` test and scoped formatting check. Later bounded runs covered the handoff/preferences files and the persistent store; their exact sequence and remaining limits are recorded below. Native Tauri/Codex and preview-capture acceptance remains unobserved after attempt 3; no native attempt is underway. Full CI (`pnpm check:all`, `pnpm test:run`, and `pnpm rust:test`) was explicitly declined and remains unrun.

Scoped static verification recorded for the earlier handoff update passed Prettier on the audit and owned TS/TSX files, ESLint on the owned TS/TSX files, and `git diff --check`. A later frontend typecheck passed after the latest frontend corrections. The current documentation/token static checks are listed in the workspace plan and final handoff; they do not cover Rust behavior.

### Current scoped evidence

- [x] Correct the CodeViewer and BrowserTools `false` handoff behavior and add focused regression tests.
- [x] Add hook-level regression coverage for the four Agent panel preference contracts.
- [x] Review the production handoff inventory and close the Preview analytics and merge-conflict failure-state gaps.
- [x] Confirm Cmd+K reset/settings and shared Skills/MCP/Plugin/Help command registrations in their owning hooks.
- [x] Document supported approval/question requests and the explicitly unsupported elicitation form path.
- [x] Run the bounded five-file handoff/preferences Vitest command after repairing its fixtures: 15/15 tests passed in 3.85 seconds, with two CodeViewer `act` warnings. A later six-file run repeated these five files and they passed again.
- [x] Run a later six-file bounded Vitest command (the five handoff/preferences files plus `agentChatStore`): 30 tests total; all five handoff files passed, while `agentChatStore` failed on a null saved-drafts result. The store defect was fixed.
- [x] Re-run `agentChatStore` alone after that fix: 15/15 tests passed in 4.12 seconds, including draft races and settings reload. The parent observed no source edits after this final store run.
- [x] Pass frontend typecheck after the latest frontend corrections, as reported by the parent.
- [x] Run the bounded Rust Chat-module command: `cargo test --manifest-path src-tauri/Cargo.toml --lib commands::agent_chat:: -- --test-threads=1` passed 47/47 tests (1,568 filtered; build 11.16s, tests 0.23s). It includes the marker-fixture patch and supersedes earlier E0597 and 45-pass/2-marker-fixture-failure attempts; no source edits followed the final run. This is module-scoped evidence, not a full Rust-suite result.
- [x] Pass scoped static checks: `check:patterns`, `docs:check`, `check:token-layers`, scoped Prettier, and `git diff --check`.
- [ ] All Chat native and preview-capture acceptance remains unobserved after attempt 3. Build and frontend provenance from this checkout were verified: `SHIPSTUDIO_DEV_PORT=1431` served both the Vite server and uniquely targeted native window URL, with an explicit window URL, unique app ID/title, and bundle path. The dashboard/New Project modal was reached, but the five-minute cap expired; no project was registered and no Chat prompt was submitted. No native attempt is underway.
- [ ] Full CI gates — explicitly declined for this round and remain unrun.
- [ ] Resolve the known `src/App.tsx` LOC gate: 1,347 lines against the 1,334-line limit. This file remains untouched in this documentation update.

### Bounded Vitest evidence

The first attempt of the five-file handoff/preferences command covered 15 tests: 13 passed and two CodeViewer tests failed because the fixture did not return the expected Promise. After repair, all 15 passed in 3.85 seconds, with two `act` warnings. A later six-file command covered 30 tests: the same five handoff/preferences files passed and the store file exposed a null saved-drafts failure. After the store fix, the standalone store command passed 15/15 in 4.12 seconds. These results establish the listed frontend test outcomes only; they are not evidence for Rust persistence, live inference, or native preview capture.

```bash
pnpm exec vitest run src/components/code/CodeViewer.test.tsx src/components/preview/BrowserTools.test.tsx src/components/preview/Preview.test.tsx src/components/branches/MergeConflictModal.test.tsx src/lib/agentChatPreferences.test.tsx
pnpm exec vitest run src/lib/agentChatStore.test.ts
```

The six-file run added `src/lib/agentChatStore.test.ts` to the first command's file list. No build or native app/provider process was started for this evidence. The repository CI gates (`pnpm check:all`, `pnpm test:run`, and `pnpm rust:test`) remain unrun by explicit direction.
