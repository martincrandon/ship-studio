# Agent Chat Phase 1 handoff audit

Audit scope: terminal-backed “send to agent” prompts, queued prompt handoffs, Cmd+K reset and Agent Settings access. The pre-existing Chat implementation was treated as the baseline; this audit does not modify `src/components/agent-chat/**`, `src/lib/agentChat*`, Rust, or `docs/agent-chat.md`.

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

## Cmd+K actions

`useAgentChatCommands` now registers **Reset Chat conversation**, available only in project context when a Chat thread is selected. It captures that thread ID and uses the shared `ProjectActionConfirmModal`; no discard command runs before the user confirms. It also registers **Agent Settings: notification sounds** in project context and **Toggle Agent auto-accept** only when the active Chat provider or selected Terminal provider supports that flag. The existing auto-accept handler retains its confirmation before enabling the mode.

Skills, MCP servers, Plugin manager, and Help already have project-level/global palette commands in `useAppCommands`; they remain available and are not duplicated. The Agent Settings dropdown also remains intact in both Chat and Terminal views.

## Evidence and remaining gaps

The audit used repository-wide searches for PTY writes, `pastePrompt`, `sendToClaude`, `onSendToAgent`, `queueHandoff`, and initial prompts, followed by tracing the callers above through their actual callbacks. The only handoff-specific direct Terminal write was the canvas comment adapter, now routed at its workspace integration. Remaining `writePtySession*` uses are terminal/build/device input paths described above. Migration fidelity can queue while a workspace is already mounted, so the queue now publishes revisions and the handoff hook observes them instead of only checking once at mount.

No Phase 1 send-to-agent caller was found that still submits a Chat prompt automatically or falls back to a hidden Terminal. The native live Codex app-server smoke test remains outstanding from the project baseline and is outside this scoped audit. The focused command test passed. `pnpm exec tsc --noEmit --pretty false` still reports errors only in out-of-scope Chat and harness files (`AgentChatPanel.tsx`, `harness/scenarios/{agentChat,workspace}.ts`, and `lib/agentChatStore{,.test}.ts`). Full CI gates were not run.

## Review follow-up

Reviewed the Phase 1 integration diffs in `App.tsx`, `useWorkflowHandoff`, `workflowHandoff`, `useTeamWorkspace`, `useWorkspaceComments`, `useAgentChatWorkspace`, `useAgentChatCommands`, and the prompt callback callers.

- The shared route stages into the currently selected Chat draft and reveals Chat for review. A missing Chat target returns failure with an explanatory toast and never falls through to Terminal. Terminal remains the route when Terminal is selected; when its active terminal ref is unavailable, the caller now gets a visible failure instead of a silent `false`.
- The handoff queue's revision subscription rechecks a newly queued prompt in an already-mounted workspace. Each attempt reads only the active project's queued record; stage/spawn and `consumeHandoff()` happen synchronously in the same attempt, and the notification after consumption causes the next effect to see an empty queue. No duplicate delivery or cross-project delivery path was found in this review.
- Canvas comment delivery checks the selected Chat target's checkout against the Preview project before staging. That Chat path has no async gap between checking and staging. Terminal comment adapters capture the workspace project path and terminal tab id, resolve the matching `projectPath::tabId` ref, and clear selection only after that terminal acknowledges the paste and only if the same project and selected thread IDs are still current. A late completion cannot clear selections made after a project or selection change. The sending indicator is also keyed to project path, so an old send cannot clear a newer project's in-progress state. Failures leave comments selected.
- Reset confirmation already captured the selected project/thread, but its async-state callback previously read the latest rendered project path. It now passes the captured project path and thread id into deletion explicitly. Confirmation text now states that the saved Ship Studio conversation, draft, and Ship Studio-owned attachments are permanently deleted while Codex provider history is retained.
- A `false` handoff result previously let several callbacks close their UI or clear typed input anyway. The Languages prompt review, merge conflict handoff, Git error handoff, PR conflict handoff, and dev-log selection now stay available on failure. PR and log-delivery analytics are recorded only after the route accepted the prompt.

Validation performed for this review: `pnpm exec vitest run src/commands/useAgentChatCommands.test.tsx` passed (1 test, 1 file, 2.21 seconds); scoped Prettier check passed; `git diff --check` passed. No broad tests or CI gates were run. The previously reported TypeScript errors in the out-of-scope Chat/harness files remain unverified against the latest shared tree. Native Tauri/Codex live-process and preview-capture validation is still open, as is acceptance of `pnpm check:all`, `pnpm test:run`, and `pnpm rust:test` after the authorized Phase 1–3 work is complete.
