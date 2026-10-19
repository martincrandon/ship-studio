# Agent Chat persistence and inbox contract

This contract covers the Rust/Tauri boundary for persistent Agent Chat threads.
All payload fields use camelCase over Tauri IPC. The SQLite database and owned
attachment files live under Tauri's `app_data_dir()/agent-chat/`, never inside a
project checkout.

## Stable project and checkout identity

- `projectId` is an app-owned UUID stored in SQLite and associated with the
  canonical Git common directory. Git worktrees for one repository therefore
  share a project inbox. Separate clones get separate identities.
- `projectPath` is the validated current project root used to scope commands.
  It can be changed only by the explicit project relink command.
- `checkoutPath` is the separately validated Git worktree where the provider
  runs. Removing a worktree preserves its thread and original path. The backend
  reports that checkout as unavailable and will not retarget it automatically.
  Relinking a checkout is an explicit operation.
- Each checkout has an app-owned UUID marker in its Git administrative
  directory, persisted with the thread in SQLite. Git removes that marker with
  the worktree metadata, so a replacement checkout at the same path receives a
  different identity. A `missing` status is a durable tombstone and stays
  unavailable until `agent_chat_relink_checkout` succeeds. Threads created
  before checkout identity tracking are marked missing and require one explicit
  relink; the backend does not infer their identity from path membership.
- Renaming/moving the Git common directory loses the path mapping but not the
  thread rows. The user can explicitly relink the stored project identity to a
  validated repository. No remote URL or folder name is used to guess identity.

## Thread snapshot

`agent_chat_list(projectPath)` returns `ChatThread[]`, ordered newest activity
first. A thread snapshot extends the live Phase 1 shape with:

```ts
interface ChatThread {
  id: string;
  projectId: string;
  projectPath: string;
  checkoutPath: string;
  checkoutStatus: 'unknown' | 'available' | 'missing';
  providerId: string;
  providerThreadId: string | null;
  resumeStatus: 'unknown' | 'available' | 'unavailable';
  providerStatus: 'unknown' | 'notLoaded' | 'idle' | 'active' | 'systemError';
  title: string;
  titleSource: 'draft' | 'prompt' | 'manual';
  status: 'idle' | 'starting' | 'running' | 'waiting' | 'interrupted' | 'error' | 'closed';
  turnId: string | null;
  items: ChatItem[]; // ordered durable display history
  requests: ChatRequest[]; // process-local; empty after restart
  draft: { text: string; attachments: ChatAttachment[] };
  settings: { modelId: string | null; reasoningEffort: string | null; autoAcceptMode: boolean };
  disposition: 'active' | 'settled';
  activityCursor: number;
  settledCursor: number | null;
  readCursor: number;
  latestActivityAt: number | null; // Unix milliseconds, from creation or observed activity
  unread: boolean; // activityCursor > readCursor
  error: string | null;
  revision: number;
}

interface StoredProject {
  id: string;
  gitCommonDir: string;
  lastPath: string;
  threadCount: number;
}

interface AgentChatStorageStatus {
  available: boolean;
  schemaVersion: number;
  error: string | null;
}

interface SavedChatDraft {
  draftId: string; // stable client-generated UUID, preserved across reloads
  projectId: string;
  checkoutPath: string;
  checkoutStatus: 'available' | 'missing';
  draft: { text: string; attachments: ChatAttachment[] };
  settings: { modelId: string | null; reasoningEffort: string | null; autoAcceptMode: boolean };
  savedAt: number; // Unix milliseconds
  state: 'draft' | 'promoted';
  promotedThreadId: string | null;
}

interface SavedChatDraftPage {
  drafts: SavedChatDraft[];
  nextOffset: number | null;
}
```

The existing item and request payloads remain unchanged. `ChatAttachment`
retains its existing fields and adds `available: boolean`; it is false when
recovery directly finds the app-owned file missing or changed. `revision` is
monotonic for each thread, including across restarts. `items` are persisted in
display order; provider requests and runtime handles are not persisted. The
checkout UUID is backend-only and is not exposed in the IPC payload. Live
snapshots cap each item's text to 64 KiB, while SQLite retains the full provider
item text and restart reconstructs the full ordered message rows before
producing those snapshots. `SavedChatDraft` records use the current validated
checkout identity as well as its path. The checkout marker remains backend-only;
`checkoutStatus` is derived from validation against the current Git worktree
list. A `draftId` belongs to exactly one project and checkout identity. A moved
or replaced checkout does not inherit drafts by matching its path.

## Commands

All commands return `Result<T, CommandError>`. Every `projectPath` is validated
with `validate_project_path`; every checkout path is validated as an existing
Git worktree belonging to that project. Thread operations are scoped to the
resolved `projectId`.

| Command | Arguments | Result and behavior |
| --- | --- | --- |
| `agent_chat_list` | `{ projectPath }` | All active and settled threads for this repository, including restored display history and saved draft/settings. Refreshes each checkout's availability from the current Git worktree list. |
| `agent_chat_list_drafts` | `{ projectPath, checkoutPath, limit?, offset? }` | Lists pending and promoted saved drafts for this exact validated checkout in pages of at most 50 (default 50); offsets above 100,000 are rejected. `nextOffset` is null at the end. Does not start a provider. For a promoted record, `promotedThreadId` is the durable binding; use the thread snapshot as the current draft/settings source. |
| `agent_chat_save_project_draft` | `{ projectPath, checkoutPath, draftId, draft, settings }` | Creates or replaces a provider-free saved draft and its attachment ownership transactionally. If promotion already bound this `draftId`, saves the late edit/capture into that bound thread's composer draft instead. |
| `agent_chat_delete_project_draft` | `{ projectPath, draftId }` | Explicitly deletes an unpromoted saved draft and its owned staged files. A promoted draft cannot be deleted through this command; discard its bound thread explicitly. |
| `agent_chat_promote_draft` | `{ projectPath, checkoutPath, draftId, providerId }` | Binds the saved draft to one durable thread, transfers its current composer contents and attachment ownership, then starts the provider conversation. Never sends a prompt. Repeated calls return the same thread and never start a second provider conversation, including after an uncertain acknowledgement or restart. The frontend calls this at first Send, then calls `agent_chat_send` separately. |
| `agent_chat_create` | `{ projectPath, checkoutPath, providerId }` | Creates an idle persisted draft thread and starts its provider conversation. No worktree is created. |
| `agent_chat_send` | `{ projectPath, threadId, text, attachments, model, effort, autoAcceptMode }` | Atomically persists the accepted user item, settings, title, and attachment ownership before requesting `turn/start`. An uncertain acknowledgement is never retried. |
| `agent_chat_save_draft` | `{ projectPath, threadId, draft: { text, attachments } }` | Persists composer contents and ownership of staged files. Call on edits and attachment changes (debounced text writes are fine). |
| `agent_chat_save_settings` | `{ projectPath, threadId, settings: { modelId, reasoningEffort, autoAcceptMode } }` | Persists settings used for subsequent turns. |
| `agent_chat_rename` | `{ projectPath, threadId, title }` | Sets a trimmed, bounded manual title and `titleSource: 'manual'`. |
| `agent_chat_reopen` | `{ projectPath, threadId }` | Makes a settled thread active and records it read through the current cursor. It never sends a prompt or changes the provider session. |
| `agent_chat_mark_read` | `{ projectPath, threadId }` | Sets `readCursor` to the current activity cursor. |
| `agent_chat_settle` | `{ projectPath, threadId }` | Sets disposition to settled and records `settledCursor = activityCursor`. Rejected while running, starting, waiting, or when the provider reports an active turn. |
| `agent_chat_resume_check` | `{ projectPath, threadId }` | Checks the saved provider thread using `thread/read` without starting a turn. Returns an updated snapshot and honest resume/provider status. The backend also performs this check before the first follow-up after restart. |
| `agent_chat_relink_checkout` | `{ projectPath, threadId, checkoutPath }` | Explicitly replaces the stored checkout only after Git worktree validation. |
| `agent_chat_discard` | `{ projectPath, threadId, confirmed }` | Requires `confirmed: true`; deletes Ship Studio history, draft, and owned attachments transactionally. It never deletes provider history or the checkout. |
| `agent_chat_storage_status` | `{}` | Returns `{ available, schemaVersion, error }` for visible migration/corruption/write failures. |
| `agent_chat_recheck_attachments` | `{ projectPath, attachments }` | Rechecks local descriptors against an app-owned attachment record with a durable owner or active stage lease, plus canonical path, regular-file, size, and MIME/kind validation. Returns descriptors with `available` set from that check; it does not recover or substitute bytes. |
| `agent_chat_list_unlinked_projects` | `{}` | Lists stored project IDs and prior paths that are not currently mapped to an available project. |
| `agent_chat_relink_project` | `{ projectId, projectPath }` | Explicitly maps an existing stored identity to a validated Git repository, updating its thread `projectPath` values. |

`agent_chat_interrupt`, `agent_chat_respond`, `agent_chat_models`, and
`agent_chat_stage_attachment` retain their Phase 1 arguments and behavior.
Selecting a row is frontend state; the backend list returns the full durable
snapshot needed to render or select any thread.

The blank composer flow uses `agent_chat_list_drafts` and
`agent_chat_save_project_draft`; it does not call `agent_chat_create` while the
user is typing or opening a new local draft. First Send calls
`agent_chat_promote_draft`, then sends the prompt separately through
`agent_chat_send`.

## Persistence and recovery semantics

- SQLite uses a `user_version` migration sequence. A database that fails
  `integrity_check`, has an unsupported future version, or cannot be opened is
  reported through `agent_chat_storage_status` and command errors; it is not
  silently reset. Existing bytes remain available for recovery.
- Staging an attachment starts an immediate SQLite transaction before copying
  the file. The new file is recorded with a 24-hour lease in that same
  transaction, so concurrent cleanup and a crash before the first composer save
  cannot mistake a just-captured file for an orphan. Saving a thread or saved
  draft replaces the lease with its durable owner row atomically. Startup and
  normal cleanup remove expired leases and then remove bytes only when no
  thread, saved draft, or active stage lease references them. A capture that was
  never committed as a draft remains recoverable for up to 24 hours; after that
  its local descriptor may still exist, but the bytes can be removed.
- Thread metadata, ordered message items, draft/settings, provider IDs,
  disposition/cursors, and attachment ownership are committed in one SQLite
  transaction per state update. Attachment copies are app-owned files; startup
  cleanup removes only files unreferenced by a committed thread draft, message,
  saved draft row, or unexpired stage lease. Saved drafts and their model/effort/approval settings are
  versioned SQLite records, independent of provider threads. Typing and opening
  a new saved draft do not start Codex. Staged attachment bytes become durably
  owned by a saved draft when its ownership is committed; a temporary stage
  lease covers the gap before that transaction. Promotion atomically stores a
  unique `draftId` → thread binding and transfers current attachment ownership
  to the thread before starting Codex. If the start acknowledgement is lost,
  retry returns the bound thread in its truthful error/interrupted state and
  does not invoke provider thread creation again. Edits or captures completing
  after promotion still address the originating `draftId`; the backend routes
  them into that bound thread. Never auto-submit the saved prompt.
- On startup, `starting`, `running`, and `waiting` threads become `interrupted`,
  process-local requests are cleared, and `resumeStatus` becomes `unknown`.
  Recovery never resends a user message and surfaces the interruption as new
  unread activity. `thread/read` confirms whether the provider conversation
  still exists; if it reports an active provider turn, a new prompt is blocked
  until that turn is no longer active. Before an explicit follow-up, the
  backend reads metadata with `thread/read`, then reconciles every provider
  turn and item through paginated `thread/turns/list` and
  `thread/items/list`. Provider items merge by stable ID; a provider user echo
  is matched to the locally accepted prompt by its text while retaining the
  local item ID and app-owned attachments. This recovers accepted-but-ack-lost
  user and assistant items without resending the prompt. Replayed history that
  does not change the normalized transcript does not advance activity cursors.
  If read, pagination, or resume is unsupported or unavailable, the snapshot
  says so and keeps local display history; the follow-up is blocked. History
  reconciliation is capped at 256 page requests and 120 seconds; exceeding
  either bound also blocks the follow-up and preserves the local transcript.
- Agent Chat requires Codex CLI 0.162.1 or newer. The baseline is checked before
  starting app-server. Its protocol was verified against the installed binary's
  generated TypeScript schema (`codex app-server generate-ts --experimental`):
  `thread/read` supports metadata-only reads, and the generated schema exposes
  paginated `thread/turns/list` and `thread/items/list` for history recovery.
- The deterministic first title comes from the first submitted prompt (or
  “Attached file” when it has no text). A manual rename is never overwritten by
  later activity.
- A provider event increments `activityCursor` only once when it creates or
  changes meaningful assistant/tool/file-change activity, a request, an error,
  or a terminal turn result. Activity newer than `settledCursor` reopens the
  thread exactly once and does not change frontend selection. Reading advances
  `readCursor`; settlement, provider status, and unread state remain independent.
- Provider notifications with stable request/item/turn identities use durable
  duplicate keys. Text delta notifications have no sequence number in the
  supported protocol, so each ordered delta frame is applied as sent (identical
  adjacent text is valid output); the final stable item and paginated history
  replace the streamed item by ID. A replayed final item or terminal turn does
  not duplicate transcript rows or inbox activity.
- Message rows append using stable item IDs and immutable SQLite ordinals. A
  bounded live view never renumbers or deletes older durable messages. Message
  attachment ownership is updated only for message IDs present in the current
  write and old owners remain until explicit discard; draft ownership alone is
  replaced when the draft changes.
- Discard requires caller confirmation and removes only Ship Studio-owned data.
  It stops a live runtime first, then deletes the SQLite rows; unreferenced file
  cleanup is safe to retry after a crash.
