# Experimental Agent Chat

Agent Chat is an optional view inside the existing Agent panel. Terminal remains
available for Claude Code, OpenCode, and other terminal agents. The project
inbox, active conversations, and collapsed Settled list share that panel; they
do not add a permanent workspace column.

## Persistent threads and recovery

The Tauri backend stores conversation history, thread drafts and settings,
attachment ownership, project identity, checkout path, status, activity cursors,
read state, and disposition in the app's `agent-chat` SQLite store. A registered
folder works with or without Git. Plain folders have one inbox scoped to that
folder; Git worktrees for one repository share an inbox and each conversation
records its exact checkout. Missing checkouts must be relinked explicitly.
Stored history stays readable even when Codex cannot resume the provider
conversation.

Plain-folder identity includes the physical folder instance. Ship Studio uses a
native directory identity where supported and an app-owned UUID marker in
`.shipstudio/agent-chat-project-id` when a native identity is unavailable. A
folder that replaces another at the same path receives a separate Chat ID; the
old history remains available from the explicit relink card. Older saved folder
rows without a verifiable instance identity remain unlinked instead of being
assigned to whichever folder now occupies their path. Moving a folder requires
explicit relinking before its history is loaded. Initializing Git retains the
plain-folder identity only when the main checkout's folder instance matches;
opening a secondary worktree first uses that same checked main-checkout binding.

Ship Studio subscribes to thread events before listing threads, then merges
snapshots by project identity and monotonic revision. It keeps unsaved local
composer edits while server snapshots update status and activity. Draft and
settings writes are serialized and versioned by draft or thread; save failures
remain visible. Model and effort IDs that are no longer discovered are shown as
unavailable, and Send stays disabled until the user chooses a supported value.
Changing these values preserves the draft's approval mode.

The first project-list response carries the authoritative project ID even when
there are no threads. Composer state stays locked until that identity is known;
path-keyed drafts are restored only for a matching saved project ID. Legacy
local drafts without an identity remain quarantined until the user explicitly
recovers them as new drafts. A folder path reused for another project does not
inherit the old folder's composer state.

Restarted conversations are not resent automatically. Interrupted or uncertain
sends require **Check Codex history** before another prompt can be sent. A
confirmed provider item remains visible as retained composer text and is blocked
from being sent twice unchanged. Local display history and provider
resumability are shown separately. Unsupported approval choices show a safe
**Stop turn** action. Policy amendment decisions are hidden because Chat cannot
apply their policy payloads safely; when Codex offers only those decisions, the
request explains the limitation and leaves **Stop turn** available. Chat sends
only base approval decisions that are both supported and offered by Codex.

Send attempts use a stable client message ID, then compare it with provider
history before merging local echoes. A matching ID confirms acceptance; equal
text alone remains ambiguous, and an older equal prompt does not confirm the
current attempt. Confirmed absence leaves the text in the composer and requires
an explicit Send click. If history cannot prove a result, the composer stays
gated. Provider history cannot prove that staged attachment bytes were
accepted, so matching text with attachments carries that uncertainty. An
explicit history check loads a `notLoaded` provider thread by resuming its same
saved provider ID, then reads status again. Active, system-error, missing,
unavailable, or unknown conversations remain gated until provider evidence
supports a follow-up.

Each accepted send stores its own settings, effective approval and sandbox
policy when returned by Codex, and durable outcome. The UI keeps that outcome
with its user message across later sends and restarts. Missing policy fields
remain unknown. Codex's returned configuration is preserved; opening Chat does
not reset approval or sandbox policy. Auto-accept only answers an offered
approval decision after the user explicitly enables it; it does not change the
configured sandbox.

Agent Chat allows at most four live Codex provider processes across the app,
including short model and history probes. Separate conversations can still
run concurrently; when capacity is full, another operation receives a clear
retry-after-capacity message.

The project inbox shows observed status, latest activity, and unread state.
Fresh activity marks a thread read only when Chat is visible and that thread is
selected. Selecting a thread while Chat is hidden does not mark it read.
**Settle** is disabled while Ship Studio or Codex reports an active turn.
**Reopen** returns a Settled thread to the active list without selecting it or
moving focus. The Cmd+K palette adds
conversation-list focus, next/previous navigation, rename, settle, and reopen
actions alongside the Phase 1 Chat actions. Reset and row-level discard use the
shared explicit confirmation modal; after confirmation the backend receives
`confirmed: true` and removes only Ship Studio history, draft, and owned files.

If storage is unavailable, the panel reports the storage error and keeps the
distinction between saved history and local draft state. If a stored project
identity has no available path, Ship Studio shows its previous path and saved
thread count and offers explicit relinking to the currently open folder or
repository. Its conversations and drafts remain in app storage while unlinked.
Relinking a moved plain folder updates the original folder's thread and draft
checkout paths; other Git worktree bindings are left alone. Git-backed records
remain bound to their saved checkout identities after project relinking.
Project identities with saved data cannot be relinked across plain-folder and
Git modes, because their checkout identity would no longer be valid. Relink a
moved plain folder to its new plain path before initializing Git there. Chat
history is app-owned and does not require Git. Git adds version history and
worktrees.

## Drafts and attachments

Typing, choosing a model, or selecting a checkout does not create a provider
thread. **New conversation** always creates a fresh blank local draft and keeps
older drafts available. Draft text, model, reasoning effort, approval mode, and
owned attachment bytes are saved in the app's SQLite store without starting
Codex. Draft lists load in pages of 50 for the current folder or checkout and,
for Git repositories, available worktrees; **Load older drafts** fetches the
next page.

First Send flushes the captured draft state, calls `agent_chat_promote_draft`
to bind that stable draft ID to a thread, and then calls `agent_chat_send`
separately exactly once. Promotion never sends the prompt. A retry after an
uncertain promotion returns the same bound thread; it does not create another
provider conversation or automatically send. A lost send acknowledgement stays
blocked after a history check when acceptance remains uncertain, with an action
to start a new conversation. Local storage serves only as migration or a
temporary fallback while SQLite writes are pending or unavailable.

Older local draft IDs are conservatively migrated to stable UUIDs. Legacy text,
settings, and attachment descriptors remain in the fallback until SQLite
confirms the write. The composer stays attached to its original draft ID while
promotion is pending, so later edits and delayed captures are saved to the
promoted thread without changing the content of the initiating Send. Model,
effort, and approval mode are stored per draft and restored on selection.
Turning on auto-accept requires confirmation.

For Git repositories, use the current checkout selector to scope a new draft.
Selecting another checkout does not create or change worktrees. **New
worktree…** opens the existing worktree flow and does not create a thread or
send a prompt by itself. Plain folders use only their registered folder and
hide worktree controls. Their chat history and settings remain persistent.
Files, pasted images, drops, and Preview captures are staged into app-owned
attachment storage and saved to SQLite as soon as staging completes. They
remain associated with the draft or thread that initiated the capture, even if
the user switches views while it completes. A capture that finishes after its
destination is discarded or unavailable is not attached to the newly selected
conversation. After restart, attachment availability stays unverified until the
saved draft or thread confirms ownership. The backend binds each staged record
to the project ID it resolves from the validated project path. Save and send
also check the exact target thread or draft owner. Rechecking a descriptor from
another project returns it unavailable; save and send reject it. Hydration updates only the availability
of matching attachment descriptors, preserving newer local text and attachment
selection. A confirmed missing or changed file keeps its identity, is marked
unavailable, and blocks Send until it is removed or reattached. If the backend
cannot verify a local descriptor, the UI keeps it unknown and gated instead of
showing a missing-file warning as fact.

## Choose the Agent panel view

Open **Settings → Experimental → Agent panel default** to choose Terminal or
Chat for projects without a saved choice. The initial default is Terminal.
Changing this default affects projects opened afterward; it does not switch the
view of a project that is already open. Use the icon-only Terminal and Chat tabs
in the Agent panel body toolbar below the header to switch the current project. The Terminal view stays
mounted while Chat is selected, so its tabs, scrollback, and running sessions
remain available.

The Cmd+K palette includes **Show Agent Chat**, **Show Agent Terminal**,
**Focus Agent Chat**, **New Chat conversation**, and **Stop current Chat turn**.
The panel retains its notification, Skills, MCP, approval-mode, plugin, and help
actions. The Chat panel identifies its provider as Codex even when another
terminal agent is active.

## Start the desktop app

From the repository root, run `pnpm tauri dev`. If pnpm asks to reinstall
dependencies or requests interactive confirmation, cancel and run
`PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm tauri dev` with the existing
`node_modules`. Live Chat requires the Codex app-server and uses the existing
Codex workspace login; it does not add a separate login flow.

## Harness scenarios

Open the web harness with `?scenario=<id>` to inspect these states:

- `agent-chat-empty`, `agent-chat-empty-draft`
- `agent-chat-saved-drafts`
- `agent-chat-streaming`, `agent-chat-approval`,
  `agent-chat-approval-amendment`, `agent-chat-question`, `agent-chat-error`
- `agent-chat-attachment`, `agent-chat-models-unavailable`,
  `agent-chat-stale-model`
- `agent-chat-project-inbox`, `agent-chat-settled-expanded`
- `agent-chat-missing-checkout`, `agent-chat-history-only`
- `agent-chat-storage-unavailable`, `agent-chat-unlinked-project`
- `agent-chat-plain-folder`
- `agent-chat-long-model-label`

The workspace fixtures implement the persistence and project-mode commands
and return the contract-shaped snapshots used by these views.

These fixtures and web harness scenarios are synthetic contract coverage. They
do not count as a live Codex app-server or native Tauri acceptance.

## Manual verification and remaining gaps

Focused frontend and backend regressions are authored for first-load identity,
send reconciliation, durable turn recovery, policy decisions, storage, and
process capacity. The bounded six-file frontend run covered 30 tests: all five
handoff/preferences files passed, while `agentChatStore` exposed a null
saved-drafts result. After fixing that defect, the standalone
`agentChatStore.test.ts` run passed 15/15 in 4.12 seconds, including draft
races and settings reload. Typecheck passed after the latest frontend
corrections. The final bounded Rust command,
`cargo test --manifest-path src-tauri/Cargo.toml --lib commands::agent_chat:: -- --test-threads=1`,
passed 47/47 tests (1,568 filtered; build 11.16s, tests 0.23s). This includes
the marker-fixture patch and supersedes earlier E0597 compilation and
45-pass/2-marker-fixture-failure attempts; no source edits followed the final
command. This is bounded module evidence, not a full Rust-suite result.
`check:patterns`, `docs:check`,
`check:token-layers`, scoped Prettier, and `git diff --check` passed. Native
attempt 3 verified build and frontend provenance from this checkout:
`SHIPSTUDIO_DEV_PORT=1431` served both Vite and the uniquely targeted native
window URL, using a unique app ID, title, and bundle path. It reached the
dashboard/New Project modal but exceeded the five-minute cap; no project was
registered and no Chat prompt was submitted. All Chat native acceptance
remains unobserved, and no native attempt is underway. Full CI was explicitly
declined and remains unrun. The untouched `src/App.tsx` is 1,347
lines against its 1,334-line limit, so the full `check:all`/LOC gate remains
unresolved.

The installed Codex CLI 0.163.0 generated-schema evidence for request resolution
and model input modalities is recorded in
[agent-chat-protocol-evidence.md](agent-chat-protocol-evidence.md). A bounded
live `initialize` and `model/list` probe also succeeded with seven catalog rows,
all reporting image input; it sent no inference turn and did not establish
inference authorization. See
[agent-chat-discovery-evidence.md](agent-chat-discovery-evidence.md). Neither
probe replaces the outstanding native checks.

The web harness was inspected at 1280px and 760px. New conversation selected a
blank local draft while keeping the older saved draft visible, and the
Terminal/Chat switch stayed in place across both views. This does not exercise
the native Codex provider flow.

Recommended manual checks:

1. Open the inbox with active, waiting, unread, and Settled threads. Confirm the
   Settled count starts collapsed, status and activity are truthful, and a
   waiting or provider-active conversation cannot be settled.
2. Select an unread row, rename it, settle it, expand Settled, then reopen it.
   Confirm reopen does not change selected conversation or steal focus.
3. Restart with a saved pre-send draft and verify text, all settings, and owned
   attachment bytes restore without creating a provider conversation.
4. Stop or interrupt a turn, restart, and verify no prompt is automatically
   retried. Check Codex history, confirm an accepted prompt is not resubmitted,
   and verify unavailable resume keeps local history readable.
5. Remove a worktree used by a thread, confirm its transcript remains, then
   explicitly relink to an existing repository worktree. Confirm the stored
   path never changes without that action.
6. In a registered plain folder, create a draft, attach a file, select model
   settings, restart, and confirm the draft and history remain. Initialize Git
   in that same folder, open a secondary worktree first, and confirm it reuses
    the original project ID only when the main folder instance matches.
   Then open the main checkout and confirm it receives the original checkout marker and
   the draft and thread remain bound there. Move a registered plain folder and
   explicitly relink it; confirm its threads and drafts load at the new path.
   Confirm Git worktree drafts keep their original path. Replace the plain
   folder at its old path and confirm the replacement starts with a new Chat
   identity while the prior history remains in the relink list. Replace Git metadata
   and confirm the old checkout is marked missing until explicitly relinked.
7. Change discovered models so a saved ID disappears. Confirm its ID is shown
   as unavailable, Send is blocked, and choosing a current model updates the
   saved setting without changing the approval mode.
8. Reset or discard a thread and cancel the confirmation once. Confirm the
   thread remains. Confirm the action and verify only Ship Studio data is
   removed.
