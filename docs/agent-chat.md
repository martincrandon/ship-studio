# Experimental Agent Chat

Agent Chat is an optional view inside the existing Agent panel. Terminal remains
available for Claude Code, OpenCode, and other terminal agents. The project
inbox, active conversations, and collapsed Settled list share that panel; they
do not add a permanent workspace column.

## Persistent threads and recovery

The Tauri backend stores conversation history, thread drafts and settings,
attachment ownership, project identity, checkout path, status, activity cursors,
read state, and disposition in the app's `agent-chat` SQLite store. Git
worktrees for one repository share a project inbox. A conversation still
records the checkout where Codex ran, and a missing checkout must be relinked
explicitly to an existing worktree. Stored history stays readable even when
Codex cannot resume the provider conversation.

Ship Studio subscribes to thread events before listing threads, then merges
snapshots by project identity and monotonic revision. It keeps unsaved local
composer edits while server snapshots update status and activity. Draft and
settings writes are serialized and versioned by draft or thread; save failures
remain visible. Model and effort IDs that are no longer discovered are shown as
unavailable, and Send stays disabled until the user chooses a supported value.
Changing these values preserves the draft's approval mode.

Restarted conversations are not resent automatically. Interrupted or uncertain
sends require **Check Codex history** before another prompt can be sent. A
confirmed provider item remains visible as retained composer text and is blocked
from being sent twice unchanged. Local display history and provider
resumability are shown separately. Unsupported approval choices show a safe
**Stop turn** action; offered amendment decisions are answered with the exact
supported decision key.

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
distinction between saved history and local draft state. If a stored repository
identity has no available path, Ship Studio shows its previous path and saved
thread count and offers explicit relinking to the currently open repository.

## Drafts and attachments

Typing, choosing a model, or selecting a checkout does not create a provider
thread. **New conversation** always creates a fresh blank local draft and keeps
older drafts available. Draft text, model, reasoning effort, approval mode, and
owned attachment bytes are saved in the app's SQLite store without starting
Codex. Draft lists load in pages of 50 for the current checkout and available
worktrees; **Load older drafts** fetches the next page.

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

Use the current checkout selector to scope a new draft. Selecting another
checkout does not create or change worktrees. **New worktree…** opens the
existing worktree flow and does not create a thread or send a prompt by itself.
Files, pasted images, drops, and Preview captures are staged into app-owned
attachment storage and saved to SQLite as soon as staging completes. They
remain associated with the draft or thread that initiated the capture, even if
the user switches views while it completes. A capture that finishes after its
destination is discarded or unavailable is not attached to the newly selected
conversation. After restart, attachment availability stays unverified until the
saved draft or thread confirms ownership. Hydration updates only the availability
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
- `agent-chat-long-model-label`

The workspace fixtures implement the persistence commands and return the
contract-shaped snapshots used by these views.

## Manual verification and remaining gaps

The schema v3 saved-draft, promotion, restart-ownership, and idempotency paths
have focused backend coverage. This frontend change has not been smoke-tested
against the live Codex app-server or in the native Tauri window. The existing
development session must be preserved for the parent agent's planned backend
reload. Verify provider login reuse, startup recovery, resume checks, approvals,
database migration errors, project relinking, and worktree checkout relinking
in that session before calling the native flow accepted. The full CI gates also
remain unrun pending approval.

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
6. Change discovered models so a saved ID disappears. Confirm its ID is shown
   as unavailable, Send is blocked, and choosing a current model updates the
   saved setting without changing the approval mode.
7. Reset or discard a thread and cancel the confirmation once. Confirm the
   thread remains. Confirm the action and verify only Ship Studio data is
   removed.
