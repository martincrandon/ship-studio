# Optional Agent Chat and Persistent Threads

Status: IMPLEMENTATION IS AUTHORIZED THROUGH PHASES 0–2 AND PRESENT IN SOURCE. The bounded Rust Chat-module test passed; all Chat native acceptance remains unobserved after attempt 3, and no native attempt is underway. Phases 3–5 remain roadmap only.
Prepared: 2026-10-13. Reconciled: 2026-10-20. Branch: `feature/agent-chat`.
Ship Studio baseline: `13cccf3a6374a33b382d04fc3085114320bc500a`.

## Outcome and agreed decisions

Add a Chat view inside the existing dockable Agent panel, alongside its Terminal view. Deliver reliable Codex conversations first, then remembered threads, then a project inbox with a collapsed Settled section. Keep the chat field, preview screenshot and crop actions, separate attachments, Agent Settings, and model selection accessible.

UI correction confirmed during implementation: Chat opens immediately to a local, editable draft. Use the T3 reference's simple rounded composer with compact controls and a slim checkout selector; avoid stacked headers, permanent status/warning rows, a create-first screen, and horizontal conversation tabs. Start the provider conversation on the first Send. Keep conversation selection in a compact menu until the later inbox phase.

Current bounded evidence: the five-file handoff/preferences Vitest run passed 15/15 in 3.85 seconds with two CodeViewer `act` warnings. A later six-file, 30-test run found a null saved-drafts result in `agentChatStore`; that defect was fixed, and the final standalone store run passed 15/15 in 4.12 seconds, covering draft races and settings reload. The latest frontend typecheck passed. The final bounded Rust command, `cargo test --manifest-path src-tauri/Cargo.toml --lib commands::agent_chat:: -- --test-threads=1`, passed 47/47 tests (1,568 filtered; build 11.16s, tests 0.23s). It includes the marker-fixture patch and supersedes earlier E0597 compilation and 45-pass/2-marker-fixture-failure attempts; no source edits followed that final command. This is module-scoped evidence, not a full Rust-suite result. `check:patterns`, `docs:check`, `check:token-layers`, scoped Prettier, and `git diff --check` passed. Installed Codex CLI 0.163.0 `initialize` and `model/list` calls succeeded with seven models reporting image input; no inference turn was sent. Native attempt 3 verified build and frontend provenance from this checkout: `SHIPSTUDIO_DEV_PORT=1431` served both Vite and the uniquely targeted native window URL, using a unique app ID, title, and bundle path. It reached the dashboard/New Project modal but exceeded the five-minute cap; no project was registered and no Chat prompt was submitted. All Chat native acceptance is unobserved, and no native attempt is underway. Full CI was explicitly declined and remains unrun. The untouched `src/App.tsx` is 1,347 lines against the 1,334-line limit, so the full `check:all`/LOC gate remains unresolved. See [Phase 1 handoff audit](../docs/agent-chat-phase1-audit.md), [Codex discovery evidence](../docs/agent-chat-discovery-evidence.md), and [native smoke evidence](../docs/agent-chat-native-evidence.md).

Documentation/token checks for this reconciliation passed: `pnpm check:patterns`, `pnpm docs:check`, `pnpm check:token-layers`, scoped Prettier, and `git diff --check`. `pnpm tokens:inventory` regenerated the inventory from the manifest before those checks.

Confirmed by Martin during planning:

- [x] Terminal and Chat may use separate conversations initially. Seamless conversation handoff is later work.
- [x] The first thread inbox is scoped to the current project. A global inbox is later work.
- [x] New agent activity returns a settled thread to the active inbox.
- [x] Terminal is the initial default. Remember the selected view per project, and add a default-view choice in Settings → Experimental.
- [x] Concurrent execution across chat threads is required from the first usable release.
- [x] Store persistent threads and attachment copies locally in app-owned SQLite storage. Stage captures/attachments until Send. Plain-folder Chat and saved history do not require Git; Git is optional and supplies version history and worktree choices.
- [x] Follow T3's explicit workspace choice for Git projects: current checkout by default, optional existing or new worktree. Never create a worktree automatically. Use Ship Studio's built-in worktree functionality.
- [x] Create a new branch and complete research/plan review before implementation.
- [x] Martin authorized implementation through Phases 0–2, using Luna sub-agents. Full CI was explicitly declined; use only bounded checks already authorized and report every unrun gate.

Use the installed Codex CLI and existing workspace-scoped login/configuration for the first Chat provider. View preference precedence: an explicitly remembered project choice overrides the Experimental default; otherwise use that default, initially Terminal. Changing the default does not rewrite project choices or switch an open panel. Unsupported providers retain Terminal with an honest explanation. A “Use default” project preference should clear the explicit override.

Confirmed lifecycle policy: switching projects, switching Chat/Terminal, or hiding the panel does not stop work while the app remains open. Explicit project close/suspend interrupts that project's active Chat turns; quitting releases provider runtimes while durable history remains. Concurrent threads use the current checkout unless the user explicitly selects a new or existing worktree.

“ChatGPT first” is interpreted as Codex using the user's existing OpenAI/ChatGPT login. This does not propose connecting to ChatGPT website conversations or adding a new API billing/authentication flow.

## Research and existing seams

### Ship Studio

The existing interface is a PTY running an agent TUI inside xterm. Ship Studio does not currently own the TUI prompt editor or its model picker. A Chat view needs its own composer and model controls; formatting terminal escape sequences is insufficient.

| Existing code | Reuse or change during implementation |
| --- | --- |
| `src/components/workspace/WorkspaceTerminalPane.tsx` | Keep the existing `agent` dock identity, panel placement, pin/hide controls and footer actions. Add a view selector and chat content boundary. |
| `src/components/terminal/Terminal.tsx` | Retain the current PTY implementation and tab/split behavior. Do not use its output as chat data. |
| `src/hooks/useTerminalManagement.ts`, `src/lib/sessionRegistry.ts` | Preserve terminal session ownership; chat thread identity must be separate from terminal tab/session IDs. |
| `src/lib/ptySession.ts`, `src-tauri/src/commands/pty_session.rs` | Reuse lifecycle lessons, but the bounded PTY output tail is not conversation persistence. |
| `src/hooks/useScreenshotManagement.ts`, `src/hooks/usePreviewCapture.ts` | Reuse viewport/full-page/crop capture. Route captured files to the originating chat draft instead of pasting a path into a terminal. |
| `src/lib/clipboard.ts` | Reuse clipboard-image staging after reviewing lifetime and validation. |
| `src/lib/agent.ts`, `src-tauri/src/agent.rs` | Reuse provider identity and binary discovery. Add structured capabilities independently of terminal CLI flags. |
| `src/lib/agentBridge.ts`, `src-tauri/src/agent_bridge.rs` | Keep the MCP preview-tool integration working for Chat. This bridge supplies tools, not assistant-message streaming. |
| `src-tauri/src/commands/projects/ui_state.rs`, `src-tauri/src/types.rs` | Extend small view-preference metadata if needed. Do not put transcripts/attachment bytes into project metadata. |
| `src/hooks/useWorkflowHandoff.ts` and prompt delivery callers | Audit delivery paths so “send to agent” targets the selected view deliberately; preserve current review-before-send semantics where they exist. |

Terminal persistence currently remembers tab metadata. Claude-specific resume wiring does not establish Codex TUI continuity. Chat must use provider-returned conversation IDs.

### Codex and other agent integration surfaces

[Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) describes a structured JSON-RPC client connection with threads, turns, item events, interruption, model discovery, and server-initiated approvals/user questions. It also offers schema generation tied to the installed CLI version. Use this surface for the initial adapter.

[Claude Code's programmatic interface](https://code.claude.com/docs/en/headless) supports structured streaming; its SDK has native messages and approval callbacks. [OpenCode's server](https://opencode.ai/docs/server/) exposes an HTTP API and event stream. These are later adapter candidates, not identical wire protocols. The contribution contract should normalize product concepts without forcing every provider to pretend it has Codex capabilities.

### T3 Code release baseline

GitHub's [latest published release](https://github.com/pingdotgg/t3code/releases/tag/v0.0.45) resolved to **v0.0.45**, released October 2, 2026, commit `6c8fed3`. Use version-pinned source references when implementing; main and the user's installed build may differ. The attached screenshot is the UX reference for a thread list and Settled section, not proof of backend semantics.

The latest stable commit is `6c8fed35dded9ff71c5b46807125457acbb76be6`. A newer prerelease, `v0.0.46-nightly.20261013.3066` (`98a6246`), was published October 13. The detailed source review uses stable v0.0.45; it does not claim a full review of the nightly. T3's [release policy](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/docs/operations/release.md) distinguishes these channels.

Findings from Luna's version-pinned source inspection:

- [CodexSessionRuntime](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L1325) owns a child `codex app-server` process and initialization/session RPCs. This supports the structured-transport recommendation. Some recovery paths fall back to a fresh thread; Ship Studio should instead expose loss of continuity and require an explicit new-thread decision.
- [ProviderAdapter](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/provider/Services/ProviderAdapter.ts#L67) separates session start/resume, send/interrupt, approval/input responses and runtime events. Borrow the seam, not every operation in the mature interface.
- [CodexAdapter](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/provider/Layers/CodexAdapter.ts#L1315) normalizes provider events before orchestration. Its [delta handling](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/provider/Layers/CodexAdapter.ts#L1788) and [MessagesTimeline](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/web/src/components/chat/MessagesTimeline.tsx) separate event ingestion from transcript presentation.
- [OrchestrationEventStore](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/persistence/Layers/OrchestrationEventStore.ts#L124) stores ordered events in SQLite. [ProjectionThreadMessages](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/persistence/Layers/ProjectionThreadMessages.ts#L51) provides queryable messages with attachments/context. Ship Studio needs transactional persistence and replay/recovery, but not T3's full event-sourced orchestration platform for its first version.
- [Sidebar classification](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/web/src/components/Sidebar.tsx#L2617) filters visible non-archived threads and separates Working, Snoozed and Settled shelves. [Sidebar logic](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/web/src/components/Sidebar.logic.ts#L809) distinguishes running work from inbox attention. Implement only Active and Settled initially.
- T3's [decider](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/orchestration/decider.ts#L1481) clears durable settlement on submitted user messages; [session activity](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/orchestration/decider.ts#L1904) and [approval/input activity](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/orchestration/decider.ts#L2191) also wake threads. Archive is separate. Ship Studio's exact event-cursor rules below are a proposed implementation of Martin's decision, not an assertion that T3 uses the same algorithm.
- [ComposerPendingApprovalPanel](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx) and [ComposerPendingUserInputPanel](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx) keep permissions distinct from questions. [Codex sendTurn](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/provider/Layers/CodexAdapter.ts#L2556) uses local image inputs, model/effort options and separate generic-file prompt handling. Borrow explicit capability handling rather than assuming every attachment is a native file upload.

T3's TypeScript/Effect backend and broad monorepo are different from Ship Studio's Rust/Tauri runtime. No Node sidecar or wholesale orchestration migration is proposed. Defer automatic settlement, snoozing, multiple accounts and T3-scale scheduling.

The release is [MIT licensed](https://github.com/pingdotgg/t3code/blob/v0.0.45/LICENSE). Preserve required notices for any substantial copied code. Prefer adapting design and lifecycle patterns to Ship Studio's Rust/Tauri architecture rather than importing its complete application stack.

## Proposed architecture

### Ownership and provider contract

Rust owns provider child processes, JSON framing, pending RPC requests, permissions, runtime lifecycle, durable storage and attachment files. React owns rendering and drafts through thin invoke wrappers and an event-backed store. Unmounting the chat panel must not own/kill the process.

Integrate the chat runtime registry with explicit project suspension/close, owning-window transfer and app shutdown. Existing `src-tauri/src/commands/projects/sessions.rs` enforces project window ownership and sweeps PTYs on suspension; `src-tauri/src/lib.rs` also cleans up PTYs at shutdown. A new child-process registry must join those boundaries. Proposed policy: ordinary project navigation preserves work; explicit project close/suspend interrupts it with truthful status, then releases the runtime. Never let two windows send through independent owners of the same thread.

Preserve backend workspace/account environment isolation when spawning app-server. `src-tauri/src/commands/pty_session.rs` currently injects workspace environment, including `CODEX_HOME`; `src-tauri/src/commands/accounts.rs` keeps environment secrets out of webview commands. Reuse that resolution so Chat uses the project's selected account. Do not read or forward credentials through JavaScript. Distinguish global preferences from per-thread overrides; do not change CLI-global configuration to select a thread's model.

Suggested new boundaries, subject to the implementation review: `src-tauri/src/commands/agent_chat/`, a backend chat runtime/provider module, `src/lib/agentChat.ts`, `src/lib/agentChatStore.ts`, and `src/components/agent-chat/`. Keep files within repository LOC limits.

Define a small provider adapter contract: discover capabilities/models, start/resume a conversation, send a turn, interrupt, answer a pending request, obtain a snapshot/history, and close the runtime. Store the Ship Studio thread ID separately from the provider conversation ID. Provider selection remains fixed per thread initially; supported model/settings changes apply to subsequent turns and are recorded per turn.

Normalize events with a schema version, thread/turn/item IDs, ordered sequence, runtime generation, and explicit payload. Core concepts: user message, assistant text, provider-exposed reasoning summary, tool activity/output, file changes, plan/status, approval, user question, error, turn completion/interruption and unknown provider activity. Preserve useful unsupported items as neutral activity rather than dropping them or claiming success. Never infer completion from silence, terminal titles or files.

Keep three independent states: provider runtime status, inbox disposition (active/settled), and unread/activity position. Settlement is organization, not cancellation or deletion.

### Concurrent threads from the first release

Phase 1 must create and switch between multiple live chat threads, with independent transcripts, drafts, provider conversation IDs, settings, pending requests and Stop actions. This moves minimal thread navigation earlier than the persistent inbox. Phase 2 adds restart persistence; Phase 3 adds the richer inbox/Settled experience.

Allow turns in different threads to execute simultaneously; serialize turn submission only within the same thread. No project-wide busy lock. A Stop or approval response targets exactly one thread/turn/request. Events for an unseen thread update its state without switching focus or overwriting the selected thread's composer.

The adapter/runtime design must prove provider concurrency rather than assume it. In the protocol spike, verify whether a shared app-server can safely multiplex simultaneous threads with independent cancellation and requests; otherwise use supervised per-thread processes under the same workspace account environment. Bound process/output resources without silently reducing execution to one turn per project. Partial failure must leave unrelated threads usable; a shared transport crash must expose every affected thread explicitly.

Bind every thread to an explicit validated checkout. Switching the project's branch/path must not silently move running threads. A shared-checkout mode allows competing file edits, Git operations and preview changes and must make that shared scope visible. Isolation cannot be claimed merely because conversation IDs differ. The agreed initial policy is current checkout by default with explicit new/existing-worktree selection; opening or sending a chat, concurrency, app restart and resuming a thread must never automatically create a worktree.

Worktree integration belongs to Phase 1 and must reuse `src/lib/worktrees.ts`, `src/hooks/useWorktrees.ts`, `src/hooks/useWorktreeWorkflow.ts`, `src/components/branches/WorktreeCreateModal.tsx` and `src-tauri/src/commands/git/worktree.rs`. No second worktree registry, directory convention, creation/removal path or automatic cleanup policy. List existing worktrees through Git-backed built-in discovery; choosing New worktree uses the existing branch/base-ref and optional environment-file-copy flow. Attach the thread only after successful creation, using the returned path; cancellation/failure must not send in an unintended checkout.

The existing creation flow seeds project metadata and a distinct dev-server port when available, and opens the checkout with a path-scoped dependency-install flow. Reuse those boundaries for chat instead of inventing ports or launching a second server for each thread. Threads sharing a checkout share its preview/dev-server session; different checkouts use their own existing session configuration. Do not silently attach a screenshot from another checkout's preview—show the actual capture source and require an explicit cross-checkout attachment when appropriate.

Extend existing worktree session teardown to chat runtimes before removal, retaining dirty-tree protections and branch-retention behavior. Removing a worktree must preserve thread history, mark its checkout unavailable, and require explicit relinking before execution; Settling/discarding a conversation must not remove its worktree. Dependency installation, branch/PR/change integration and workspace/account/plugin resolution must stay consistent with the built-in worktree workflow. Decide whether the initial thread list groups linked checkouts under their parent repository or filters the exact open checkout during the identity contract review; execution paths must remain distinct either way.

T3 comparison, checked in stable v0.0.45: its [new-thread defaults](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/web/src/hooks/useHandleNewThread.ts#L96) honor configured workspace defaults, falling back to current checkout when unconfigured. The [workspace selector](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/web/src/components/BranchToolbar.tsx#L275) offers current checkout, new worktree and recent-worktree reuse. Its [workspace lease](https://github.com/pingdotgg/t3code/blob/6c8fed35dded9ff71c5b46807125457acbb76be6/apps/server/src/workspace/workspaceLease.ts#L4) coordinates selected lifecycle operations, not all edits throughout an agent turn; no conflict-prevention guarantee was established for concurrent shared-checkout agents. Preview sessions are thread/tab scoped, but separate dev-server/port isolation was not established. Ship Studio follows the explicit-choice pattern while reusing its own worktree and preview lifecycle.

### Reliability rules

- Listen before starting work; obtain an authoritative snapshot plus ordered events on reattach. Prevent gaps with an atomic snapshot/subscription handshake or replay from a sequence cursor.
- Parse partial/multiple JSON lines; correlate responses separately from notifications and incoming provider requests. Keep stderr separate from protocol stdout.
- Use request/startup timeouts and bounded queues/output. A long-lived provider is a supervised process, not an unbounded `.output().await` or a whole-turn timeout masquerading as a request timeout.
- Apply deltas by stable item ID; final items replace partial content. Replaying events must not duplicate messages or tool output.
- Batch render updates and coalesce transient deltas. Keep terminal states and request events lossless; add transcript windowing when measured volume warrants it.
- Fail, interrupt and disconnect are different states. Keep drafts on failed send. If send acknowledgement is uncertain, reconcile provider history before allowing a retry; never automatically replay a prompt that may already be executing.
- Approvals, questions and supported MCP elicitation must be actionable in the first usable release. Correlate answers to the exact pending request and reject stale answers. Unsupported interactive requests receive a clear safe rejection/error, not an endless spinner.
- A disconnected process cannot be called “working.” Resume/read the provider thread to reconcile state; do not automatically rerun an interrupted turn after app restart.
- Validate project paths and attachment access, scope operations by project/thread, preserve configured approval/sandbox policy, and avoid logging prompt contents or credentials.
- Probe and document a tested minimum Codex version. Generated protocol schemas and fixtures must match that baseline; the installed CLI can be newer. Do not assume the screenshot's CLI version or bundled model names are universal.

### Composer, captures and rendering

Reuse shared buttons, menus, controls and design tokens. Put Chat/Terminal selection in the existing Agent panel. Fit the transcript and composer in narrow, docked and floating panel widths; keep a discoverable route back to Terminal for unsupported agents.

The composer supports text, file selection, paste/drop, removable attachment previews, Send and Stop. Preserve drafts per thread/view. Enter sends and Shift+Enter inserts a newline, with IME composition handled. While a turn is running in the selected thread, keep its draft and disable another send to that thread initially; sending in another thread remains available. Steering/queues within a single thread are later capabilities.

Capture must bind to the project and draft that initiated it. A project/thread switch during a crop or capture must never attach the result to a different conversation. Stage viewport/full-page/cropped screenshots visibly before Send. Keep the existing preview availability gates and permission UX.

Images must be sent as supported provider image inputs, not merely text paths. Non-image files need an explicit adapter mapping (for example a validated local file reference the agent can read), honest UI labels, size/type limits and actionable rejection. Copy staged attachments into owned local storage so reopening a thread does not depend on a temporary screenshot or an original file that has changed.

Render Markdown paragraphs, lists, tables, inline/fenced code and links; preserve partial fences while streaming. Review existing sanitized report rendering for reuse, but verify streaming behavior separately. Disallow unsafe raw HTML/URL schemes and arbitrary remote image fetches. Add code copy, collapsible tool activity/output, basic file-change/plan displays, errors, approvals and questions. Only show reasoning summaries that the provider exposes. Auto-scroll follows new content only while the reader is near the bottom; otherwise show a new-content affordance.

Model and effort options come from supported provider data, not a hard-coded list. Unknown/unavailable values need honest states. Agent Settings retains notifications, skills, MCP, help and approval-mode access; capability gating makes unsupported actions clear. A preference change must not silently escalate permissions or restart a busy thread.

### Persistence recommendation

Use a versioned **app-owned SQLite store**, introduced with the persistence phase, outside user repositories. Local SQLite storage and staged attachments are approved product decisions; select the Rust dependency and schema during the implementation contract review.

Own thread metadata, ordered display history, turn settings/status, drafts, read cursors and inbox disposition. Let the provider own model context/session semantics; store its returned ID and use its supported resume/read APIs. Do not implement resume by resending the display transcript. Clearly distinguish “history available” from “provider conversation resumable.”

Use a stable project identity plus a separately validated current checkout path; branch/worktree changes must not silently retarget running work. Start with current-project threads, keeping the schema suitable for a later global list. Finalize identity/relink behavior before persistence lands.

Persist accepted messages before exposing them as durable. Use transactions for lifecycle changes and an attachment ownership/cleanup policy for crash or partial-write cases. Never expire saved conversations automatically. Discard uses the existing confirmation pattern and deletes Ship Studio history/owned attachments; provider-native deletion requires a separate explicit scope and capability decision.

## Delivery roadmap and acceptance gates

### Phase 0 — contract and bounded protocol spike

- [x] Record the defaults and implementation decisions Martin confirmed during review, including plain-folder Chat and Git-optional history.
- [x] Stop active Chat turns when a project is explicitly closed or suspended. Navigation and view switching preserve running work.
- [x] Verify the installed Codex binary/config/auth discovery and run bounded live `initialize` and `model/list` with Codex CLI 0.163.0. Both calls succeeded and returned seven models, all reporting image input. This proves catalog access using copied Default-account auth/config contents; it does not prove the server identity or inference authorization. See [bounded discovery evidence](../docs/agent-chat-discovery-evidence.md).
- [ ] Prove structured text turns, tool activity, approval/question, interrupt and image input through Rust/Tauri in a disposable fixture project, including two simultaneously executing threads and cancellation/request isolation. Native proof has not been demonstrated.
- [x] Specify the normalized event/adapter contract and runtime lifetime; add recorded/synthetic protocol fixtures. See [agent-chat-protocol-evidence.md](../docs/agent-chat-protocol-evidence.md) for the limits of generated-schema evidence.
- [x] Specify current-checkout defaults, explicit built-in worktree selection for Git projects, and provider concurrency architecture before Phase 1. Plain folders remain valid Chat projects without Git.
- [x] Select the SQLite dependency and app-owned attachment mapping before durable storage implementation.
- [x] Implement authoritative project identity behavior for empty thread lists, including server-returned project UUID gating, plain-folder instance identity, Git initialization when a secondary worktree opens first, verified main-checkout binding, relinking, and legacy identity-free draft quarantine/recovery. The persistence contract documents these rules. The bounded `commands::agent_chat::` Rust test passed 47/47; full Rust-suite acceptance remains unverified.

Exit: the contract, bounded CLI discovery, identity implementation, and bounded Rust Chat-module test are recorded. Phase 0 acceptance remains unchecked because native protocol behavior is unobserved. Report unsupported event/request types explicitly; CLI model discovery, generated schema, and synthetic fixtures are not native acceptance.

### Phase 1 — optional, usable Codex Chat

- [x] Add per-project Chat/Terminal selection and Settings → Experimental default-view control, initially Terminal. Honor project override/default precedence. Preserve terminal tabs/splits, pin/hide and panel docking.
- [x] Add the backend-owned Codex adapter and frontend event store with event subscription, revision-aware snapshots and safe reattach behavior.
- [x] Resume the same saved provider thread when a history check finds `notLoaded`, then read its status again; keep this distinct from confirmed unavailability and never create a replacement thread.
- [x] Implement create/select navigation for multiple live conversations per project, per-thread drafts and settings, independent turn state, text composition and streaming transcript.
- [x] Bound provider-process admission globally to four live Codex processes, including model/history probes, and serialize sends within each thread while allowing distinct threads to execute concurrently.
- [x] Apply the agreed checkout policy, display each thread's execution scope, and route per-thread Stop, request responses and background activity correctly.
- [x] Preserve provider-returned effective sandbox and approval configuration on thread start/resume and per accepted turn; do not send overrides that broaden policy. Chat exposes only supported decisions offered by Codex. Native behavior remains unobserved.
- [x] Offer Current checkout, existing worktree and New worktree through the built-in worktree APIs/modal; reuse metadata, dependency installation, port and preview sessions; include Chat runtimes in worktree teardown. Never auto-create on send/resume/concurrency.
- [x] Render Markdown, tools, basic file changes/plans, explicit status, interruption and errors.
- [x] Handle approvals and user questions; handle or reject other interactive requests clearly.
- [x] Hide unsupported approval policy amendments that Chat cannot safely apply; offer only supported choices Codex explicitly presents and a clear stop/cancel path when none remain.
- [x] Add model/effort controls and preserve Agent Settings actions/capabilities.
- [x] Route viewport/full-page/crop, file chooser and clipboard/drop through staged attachments.
- [x] Preserve preview MCP, plugins and prompt delivery integrations, including explicit-review prompt delivery into the Chat draft.
- [x] Finish auditing terminal-dependent “send to agent” callers. The bounded inventory and failure-state review are in [agent-chat-phase1-audit.md](../docs/agent-chat-phase1-audit.md).
- [x] Register view-switch, focus-chat, new-conversation, stop, reset and Agent Settings actions with `useCommands`. This is ordinary palette support, not the deferred arbitrary-text background-send feature.
- [x] Add fixture backend commands and harness scenarios for empty, streaming, approval, question, error, unavailable agent and attachments.

Exit: implementation is present for send → streamed reply/tools → follow-up, independent thread state, checkout selection, captures, request handling, palette actions and Terminal fallback. Phase 1 acceptance remains unchecked because native Tauri/Codex behavior for two simultaneously executing threads, provider request/interrupt isolation, image input, approvals/questions, preview capture, worktree routing and effective sandbox/approval behavior is unobserved. Do not infer these outcomes from harness fixtures or the bounded frontend tests. Experimental default and remembered project choices follow precedence. Reset/discard requires explicit confirmation and does not delete provider-owned history.

### Phase 2 — persistent threads

- [x] Introduce versioned SQLite storage, transactional thread/message history and app-owned attachment storage outside project folders.
- [x] Add persisted draft/thread create and select, rename, reopen and discard; derive the initial title deterministically from the first submitted prompt and preserve manual rename.
- [x] Save editable drafts, per-draft/per-thread model and approval settings, provider conversation IDs, and explicit thread/runtime state.
- [x] Persist settings, provider-returned effective policy, reconciliation status, and durable outcome for every accepted turn; restore those records with the thread.
- [x] Restore local history and owned attachments after restart; mark unfinished turns interrupted and never automatically replay a prompt.
- [x] Resume the exact saved provider ID when `notLoaded`, reconcile the attempt against provider history before merging local echoes, and preserve local display history when provider history is unavailable.
- [x] Reconcile each uncertain send by its attempt ID as `confirmedPresent`, `confirmedAbsent`, or `ambiguous`. `confirmedPresent` blocks an unchanged duplicate but allows a different follow-up once Codex is idle; `confirmedAbsent` keeps the text in the composer and permits only an explicit user retry, with no automatic replay; `ambiguous` keeps sending gated.
- [x] Add schema migrations, visible corruption/error reporting and attachment cleanup/recovery. Newly staged attachments receive trusted content digests; legacy digest-unknown attachments retain validation and are not silently baselined.

Exit: Phase 2 implementation, including empty-list identity gating and recovery behavior, is present in source and documented. The bounded Rust Chat-module test passed 47/47. Native restart/resume behavior is unobserved, and Phase 2 native acceptance remains unchecked. Relaunch must restore the same messages and attachments; follow-up must use the saved provider thread; uncertain sends must not duplicate execution; deleted/failed/interrupted states must remain truthful; and activity from another project must not leak into this transcript.

#### Phase 0–2 evidence and acceptance gates

- **Phase 0 evidence:** bounded CLI `initialize` and `model/list` both passed with Codex CLI 0.163.0 and returned seven image-capable catalog rows. This is catalog/auth-config access evidence only; it is not inference authorization or native Tauri protocol acceptance. Identity implementation is present and documented, and the bounded Rust Chat-module test passed 47/47. **Native observation:** protocol acceptance is unobserved.
- **Phase 1 evidence:** source and docs cover preference precedence, thread-scoped routing, staged attachments, request handling, built-in worktree integration, palette actions, same-ID `notLoaded` recovery, a global four-process cap, per-thread serialization, and preservation of provider policy. The handoff audit records the caller inventory and failure-state fixes. **Native observation:** two-thread/provider/preview behavior is unobserved.
- **Phase 2 evidence:** source and contract cover schema 8, authoritative empty-list identity, plain-folder/Git identity and relinking, legacy draft quarantine/recovery, saved drafts, thread history, attachment ownership/digests/cleanup, per-turn settings/outcomes, same-ID resume, and attempt-bound reconciliation. Frontend `agentChatStore` passed its final standalone 15/15 run (4.12 seconds). The bounded Rust Chat-module test passed 47/47 (1,568 filtered; build 11.16s, tests 0.23s). Earlier E0597 and 45-pass/2-marker-fixture-failure attempts are superseded by this run after the marker-fixture patch; no source edits followed it. **Native observation:** restart/resume behavior is unobserved. These bounded results are not full-suite acceptance.
- [x] Record bounded app-server initialize/model-list discovery in [agent-chat-discovery-evidence.md](../docs/agent-chat-discovery-evidence.md), with the limits of that evidence stated.
- [x] Run the bounded Rust Chat-module command: `cargo test --manifest-path src-tauri/Cargo.toml --lib commands::agent_chat:: -- --test-threads=1` passed 47/47 tests (1,568 filtered; build 11.16s, tests 0.23s), including the marker-fixture patch. This supersedes earlier E0597 and 45-pass/2-marker-fixture-failure attempts; no source edits followed.
- [ ] Complete native Tauri/Codex acceptance for text/tools/image/questions/approval/interrupt, two concurrent threads, lifecycle/relaunch and saved provider IDs.

Full CI (`pnpm check:all`, `pnpm test:run`, `pnpm rust:test`) was explicitly declined for this round and remains unrun; the bounded module test is not a substitute. The untouched `src/App.tsx` is 1,347 lines against the 1,334-line limit, so the full `check:all`/LOC gate remains unresolved. The bounded frontend sequence and its limits are recorded in [agent-chat-phase1-audit.md](../docs/agent-chat-phase1-audit.md). Native attempt 3 verified build and frontend provenance from this checkout at port 1431 and uniquely targeted the window, but reached only the dashboard/New Project modal before the five-minute cap; no project was registered and no Chat prompt was submitted. All Chat native acceptance remains unchecked and unobserved, and no further native attempt is underway ([native evidence](../docs/agent-chat-native-evidence.md)).

### Phase 3 — project inbox and Settled

- [ ] Add a project-scoped thread list in the Agent panel with a collapsible/narrow-panel presentation rather than stealing a permanent extra workspace column.
- [ ] Show observed running/waiting/error state, latest activity, unread indication and renameable title.
- [ ] Add Settle/Reopen and a collapsed Settled list with count.
- [ ] Reopen on new meaningful agent activity (assistant content, tool activity, approval/question or terminal turn result), including activity in an unseen thread. Ignore replayed history, keepalives and duplicate events.
- [ ] Settlement records an event cursor; only later events reopen. Reopening on activity must not steal focus.
- [ ] Recommend disabling Settle while a turn is running or waiting for a response to avoid immediate repeated reopening.
- [ ] Keep settlement distinct from provider archive/delete; preserve history and resumability.
- [ ] Add keyboard navigation, relevant Cmd+K actions and fixture/harness states for active/unread/waiting/settled.

Exit: disposition survives restart; settled activity reopens exactly once; no stale/replayed events cause inbox churn.

### Phase 4 — contributor adapters and optional enhancements

- [ ] Publish the adapter interface, event examples, capability matrix, conformance fixtures and provider contributor guide.
- [ ] Add Claude Code, then OpenCode/other agents as separate scoped contributions with provider-specific approval/auth/resume testing.
- [ ] Add optional seamless Terminal/Chat handoff only where a provider can guarantee session continuity; never fabricate continuity by copying screen text.
- [ ] Consider global inbox, search and steering/queued prompts after the stable project inbox. Explicit worktree selection and its built-in lifecycle integration already belong to Phase 1.

### Phase 5 — deferred Cmd+K background new thread

- [ ] Let arbitrary command-menu text expose “Send to agent in new thread.”
- [ ] Resolve project, provider, model and checkout explicitly; from Home require a known target or prompt for one.
- [ ] Create/persist the thread and submitted message, then dispatch through the backend thread service while leaving the current view unchanged.
- [ ] Show creation/failure feedback and inbox activity; bring approvals/questions to attention without automatically granting them.
- [ ] Respect the concurrency policy and prevent duplicate dispatch.

Do not begin Phase 5 until chat, persistence and inbox are stable. Background means while Ship Studio is running; execution while the app is closed is separate work.

## Validation and delegation

The conductor defines contracts, reviews integration/risk and accepts phases. Delegate implementation and scoped research/check work to **GPT-6-Luna**: Medium for narrow UI/wrappers/docs, High/Extra High for adapters/rendering, Max for lifecycle/persistence/recovery. Give each task exact files, invariants, fixture inputs and exit criteria; keep shared schema work sequential to avoid conflicting edits. Martin explicitly authorized implementation through Phases 0–2. Phases 3–5 remain roadmap only; their acceptance checkboxes stay unchanged.

For each change, start with one bounded meaningful test where needed. Protocol fixtures should cover chunk framing, replay/final-item deduplication, unanswered/stale requests, failed/interrupted turns and uncertain-send reconciliation. Persistence checks must cover restart recovery/attachment survival; inbox checks must cover settle cursor/reopen rules. Harness/manual checks cover narrow/docked/floating views, scroll behavior, keyboard/IME, settings and screenshot/crop paths. At least one deliberate native Tauri check is needed because browser fixtures cannot prove provider processes or native preview capture.

Concurrent fixtures must interleave two threads' deltas, approvals and completion events, verify independent drafts/model overrides/Stop actions, and exercise one-thread failure plus shared-process failure if multiplexing is used. Verify view preference precedence separately. Worktree mode, if selected, additionally needs checkout/preview routing and safe lifecycle coverage.

The repository normally requires `pnpm check:all`, `pnpm test:run` and `pnpm rust:test` before declaring implementation complete. Martin explicitly declined full CI for this round; do not run those gates or ask again here, and do not substitute bounded checks for them. This plan-update task does not authorize new tests, builds or native processes; record existing evidence and its limits.

Follow CLAUDE.md and CONTRIBUTING_PATTERNS: shared controls/hooks/modals, ordered design tokens, Cmd+K registry, `CommandError`, `validate_project_path`, tracing and bounded external-command behavior. Long-lived structured processes need supervised cancellation/read/request bounds, reviewed against the existing helper pattern.

## Remaining review cautions

Resolved decisions: Terminal is the initial default with an Experimental default choice and remembered project overrides; concurrent execution is required from the first usable release; local SQLite persistence and staged attachments; plain-folder Chat/history without Git; Git as an optional source of version history and built-in worktrees; current checkout by default with explicit existing/new worktree selection; navigation and hiding preserve running work, project close/suspend interrupts it, and app quit releases runtimes while history persists. Implementation through Phases 0–2 is authorized. Phases 3–5 remain roadmap only and their acceptance checkboxes are unchanged.

Review issues to surface: separate conversations must be clearly labelled; provider-version drift needs capability checks; Chat settings cannot be supplied by the old TUI; missing provider history must never be masked by inventing a resumed conversation; project/global inboxes differ from the existing workflow Findings Inbox and need distinct product naming.
