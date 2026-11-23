# Agent Chat persistence and inbox contract

This contract covers the Rust/Tauri boundary for persistent Agent Chat threads.
All payload fields use camelCase over Tauri IPC. The SQLite database and owned
attachment files live under Tauri's `app_data_dir()/agent-chat/`, never inside a
project checkout.

## Stable project and checkout identity

- `projectId` is an app-owned UUID stored in SQLite. Git projects are associated
  with the canonical Git common directory, so worktrees share one inbox and
  separate clones get separate identities. A non-Git folder gets one inbox
  scoped to that physical folder instance; its canonical path is a lookup hint,
  not proof that a folder at the same path is the same project.
- SQLite stores a tagged identity key and, for plain folders, a separate stable
  folder-instance identity. Unix systems use the directory's native device and
  inode values. Platforms without a supported native identity use the
  app-owned UUID marker `.shipstudio/agent-chat-project-id`; if neither method
  can verify the folder, Chat fails closed and asks for an explicit relink.
  The marker fallback may be copied with a project: if both folders still
  exist, the copy receives a new marker; if a saved folder moved, Chat requires
  explicit relinking. Git projects remain associated with the canonical Git
  common directory. If a project's `.git` metadata disappears, Chat does not
  reclassify it as plain: it reports the Git identity error and offers explicit
  project relinking.
- Schema 8 leaves older plain-folder rows without a trusted instance identity
  unverified; it does not derive one from existing files or backfill from the
  path. When a folder occupies one of those old paths, a fresh identity is
  created and the old project is shown for recovery, even while that path
  exists. Existing history and drafts are retained until the user explicitly
  relinks them.
- When Git is initialized in a folder already registered for Chat, the existing
  project row and UUID are retained only when the main checkout has the same
  verified folder-instance identity. Git's worktree list identifies the main
  checkout, so opening a secondary worktree first still finds that verified
  binding and does not create a second project. SQLite records a pending
  identity and main-checkout path; only that exact main checkout receives the
  prior plain-folder UUID checkout marker. A replacement or unverified folder
  does not inherit the old Chat identity; its old row remains recoverable and
  the new Git project receives a separate identity.
- `projectPath` is the validated current project root used to scope commands.
  It can be changed only by the explicit project relink command.
- `checkoutPath` is the separately validated folder where the provider runs.
  In a plain project it must be the project folder itself. In a Git project it
  must be a worktree belonging to that repository. Removing a worktree
  preserves its thread and original path. The backend reports that checkout as
  unavailable and will not retarget it automatically. Relinking is explicit.
- Each checkout has an app-owned UUID marker in its Git administrative
  directory, persisted with the thread in SQLite. Git removes that marker with
  the worktree metadata, so a replacement checkout at the same path receives a
  different identity. A `missing` status is a durable tombstone and stays
  unavailable until `agent_chat_relink_checkout` succeeds. Threads created
  before checkout identity tracking are marked missing and require one explicit
  relink; the backend does not infer their identity from path membership.
- Moving a plain folder loses the path mapping but not its threads or saved
  drafts. Explicitly relinking that plain identity to the moved plain folder
  updates only bindings whose checkout identity and old path identify that
  original folder; Git worktree bindings stay unchanged. Renaming/moving a Git
  common directory preserves its stored data but requires explicit project and
  checkout relinking. Project identities with saved data cannot be explicitly
  relinked across plain-folder and Git modes because that would strand checkout
  bindings. For a moved plain folder, relink it to the new plain folder before
  initializing Git there. No remote URL or folder name is used to guess
  identity. Unlinked data remains in app storage and becomes available in Chat
  only after an explicit project link.

## Thread snapshot

`agent_chat_list(projectPath)` returns an authoritative project snapshot even
when no thread exists. Its thread array is ordered newest activity first:

```ts
interface ChatProjectSnapshot {
  projectId: string;
  threads: ChatThread[];
}
```

A thread snapshot extends the live Phase 1 shape with:

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
  approvalPolicy: unknown | null; // effective provider value, if returned
  sandboxPolicy: unknown | null; // effective provider value, if returned
  turns: ChatTurnRecord[]; // durable per-send outcome and settings snapshots
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

interface ChatTurnRecord {
  id: string; // Ship Studio send-attempt/client message ID
  providerTurnId: string | null;
  userItemId: string;
  outcome: 'claimed' | 'sending' | 'running' | 'completed' | 'interrupted' | 'failed' | 'uncertain';
  settings: { modelId: string | null; reasoningEffort: string | null; autoAcceptMode: boolean };
  approvalPolicy: unknown | null;
  sandboxPolicy: unknown | null;
  reconciliation: ChatSendReconciliation | null;
  startedAt: number;
  finishedAt: number | null;
}

interface ChatSendReconciliation {
  attemptId: string;
  outcome: 'confirmedPresent' | 'confirmedAbsent' | 'ambiguous';
  attachmentAcceptance: 'notApplicable' | 'confirmed' | 'unknown';
  providerTurnId: string | null;
}

interface StoredProject {
  id: string;
  identityKey: string;
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
checkout identity as well as its path. Git checkout markers remain backend-only;
a plain folder uses its project UUID as its checkout identity until the
deliberate Git initialization handoff writes that UUID as its first marker.
`checkoutStatus` is derived from the current project mode and checkout
validation. A `draftId` belongs to exactly one project and checkout identity. A
moved or replaced checkout does not inherit drafts by matching its path.
The frontend uses `projectId` from `ChatProjectSnapshot` before loading or
writing drafts. Legacy composer state without a known project ID is quarantined
under the same path and can only be copied into new drafts after the user asks
to recover it. A project identity change clears path-keyed active state and
invalidates in-flight draft operations before another draft can be loaded.

`ChatTurnRecord` is stored in each thread's JSON with serde defaults, so adding
it does not require a SQLite version change. It retains the settings and
provider-returned policy effective for that particular send, along with the
provider outcome. The current SQLite schema is version 8. Schema v7 adds
`attachments.content_sha256`: newly staged bytes have a trusted SHA-256 digest
checked when recovered; migrated v6 attachment rows keep a null digest because
the old database did not establish byte integrity. Those legacy files retain
the earlier ownership, path, file type, size, and MIME/kind checks, but are not
described as byte-integrity verified. Schema v8 adds the stable plain-folder
instance binding and server-derived attachment project scope.

## Commands

All commands return `Result<T, CommandError>`. Every `projectPath` is validated
with `validate_project_path`; a plain project's checkout path must canonicalize
to the project folder, and a Git checkout must be an existing worktree belonging
to that repository. Thread operations are scoped to the resolved `projectId`.

| Command | Arguments | Result and behavior |
| --- | --- | --- |
| `agent_chat_list` | `{ projectPath }` | Returns `{ projectId, threads }`, including the authoritative identity when there are zero threads. Threads include restored display history and saved draft/settings. Refreshes checkout availability using the plain-folder identity or current Git worktree list. |
| `agent_chat_project_mode` | `{ projectPath }` | Resolves the registered project's Git mode using the same identity checks as thread listing. Git metadata and CLI failures return an error instead of reporting a plain folder. |
| `agent_chat_list_drafts` | `{ projectPath, expectedProjectId, checkoutPath, limit?, offset? }` | Lists pending and promoted saved drafts for this exact validated checkout and expected identity in pages of at most 50 (default 50); offsets above 100,000 are rejected. `nextOffset` is null at the end. Does not start a provider. |
| `agent_chat_save_project_draft` | `{ projectPath, expectedProjectId, checkoutPath, draftId, draft, settings }` | Creates or replaces a provider-free saved draft and its attachment ownership transactionally. Rejects a project identity change. If promotion already bound this `draftId`, saves the late edit/capture into that bound thread's composer draft instead. |
| `agent_chat_delete_project_draft` | `{ projectPath, expectedProjectId, draftId }` | Explicitly deletes an unpromoted saved draft and its owned staged files. A promoted draft cannot be deleted through this command; discard its bound thread explicitly. |
| `agent_chat_promote_draft` | `{ projectPath, expectedProjectId, checkoutPath, draftId, providerId }` | Binds the saved draft to one durable thread, transfers its current composer contents and attachment ownership, then starts the provider conversation. Never sends a prompt. Repeated calls return the same thread and never start a second provider conversation. |
| `agent_chat_create` | `{ projectPath, expectedProjectId, checkoutPath, providerId }` | Creates an idle persisted draft thread and starts its provider conversation. No worktree is created. |
| `agent_chat_send` | `{ projectPath, expectedProjectId, threadId, text, attachments, model, effort, autoAcceptMode, sendAttemptId }` | Persists a per-attempt settings/policy snapshot and local user item before requesting `turn/start`. The `sendAttemptId` is sent as `clientUserMessageId` and is never automatically replayed. |
| `agent_chat_save_draft` | `{ projectPath, threadId, draft: { text, attachments } }` | Persists composer contents and ownership of staged files. Call on edits and attachment changes (debounced text writes are fine). |
| `agent_chat_save_settings` | `{ projectPath, threadId, settings: { modelId, reasoningEffort, autoAcceptMode } }` | Persists settings used for subsequent turns. |
| `agent_chat_rename` | `{ projectPath, threadId, title }` | Sets a trimmed, bounded manual title and `titleSource: 'manual'`. |
| `agent_chat_reopen` | `{ projectPath, threadId }` | Makes a settled thread active and records it read through the current cursor. It never sends a prompt or changes the provider session. |
| `agent_chat_mark_read` | `{ projectPath, threadId }` | Sets `readCursor` to the current activity cursor. |
| `agent_chat_settle` | `{ projectPath, threadId }` | Sets disposition to settled and records `settledCursor = activityCursor`. Rejected while running, starting, waiting, or when the provider reports an active turn. |
| `agent_chat_resume_check` | `{ projectPath, threadId }` | Checks the exact saved provider thread. If `thread/read` returns `notLoaded`, resumes that same provider ID and reads its status again. Reconciles send attempts before merging local user echoes. It never creates a replacement provider thread. |
| `agent_chat_relink_checkout` | `{ projectPath, threadId, checkoutPath }` | Explicitly replaces the stored checkout after folder or Git worktree validation. |
| `agent_chat_discard` | `{ projectPath, threadId, confirmed }` | Requires `confirmed: true`; deletes Ship Studio history, draft, and owned attachments transactionally. It never deletes provider history or the checkout. |
| `agent_chat_storage_status` | `{}` | Returns `{ available, schemaVersion, error }` for visible migration/corruption/write failures. |
| `agent_chat_recheck_attachments` | `{ projectPath, attachments }` | Rechecks local descriptors against an app-owned attachment record scoped to the server-resolved project ID and a durable owner or active stage lease, plus canonical path, regular-file, size, MIME/kind, and trusted digest validation. Descriptors from another project return unavailable; it does not recover or substitute bytes. |
| `agent_chat_list_unlinked_projects` | `{}` | Lists stored project IDs and prior paths that are not currently mapped to an available project, including plain-folder rows whose old path still exists but now identifies a different or unverified folder instance. |
| `agent_chat_relink_project` | `{ projectId, projectPath }` | Explicitly maps an existing stored identity to a validated folder or Git repository. A plain-folder move also updates that folder's thread and saved-draft checkout paths. Project identities with saved data cannot be relinked across plain-folder and Git modes. Conflicting histories remain separate; a conflict-free empty row at the target may be removed in the same transaction. |

`agent_chat_stage_attachment` takes `{ projectPath, path }`; the backend
resolves the project ID from the validated path and binds the staged record to
that project. The returned attachment descriptor shape is unchanged.
`agent_chat_interrupt`, `agent_chat_respond`, and `agent_chat_models` retain
their Phase 1 arguments. Selecting a row is frontend state; the backend list
returns the full durable snapshot needed to render or select any thread.

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
  transaction with the project ID resolved from the validated project path, so
  concurrent cleanup and a crash before the first composer save cannot mistake
  a just-captured file for an orphan. Save and send validate both that project
  ID and the target thread or draft owner. Recheck is project-scoped. Saving a
  thread or saved draft replaces the lease with its durable owner row atomically. Startup and
  normal cleanup remove expired leases and then remove bytes only when no
  thread, saved draft, or active stage lease references them. A capture that was
  never committed as a draft remains recoverable for up to 24 hours; after that
  its local descriptor may still exist, but the bytes can be removed.
- Schema version 7 adds `attachments.content_sha256`. Newly staged bytes store a
  trusted SHA-256 digest and are checked against it during recovery. Migrated
  v6 rows keep a null digest because their original bytes were never hashed;
  legacy recovery retains the existing owner, canonical path, regular file,
  size, and MIME/kind checks without claiming byte-integrity verification.
- Schema version 8 adds the plain-folder instance identity and attachment
  project scope. Plain-folder identities are not backfilled from their paths.
  Attachment project scope is backfilled only when existing thread or saved
  draft owner rows identify exactly one project. Ownerless legacy stage leases
  and conflicting legacy owners remain unverified and must be staged again;
  their files are not assigned an inferred project from a path.
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
  Clean shutdown and explicit project suspension also mark any claimed, sending,
  or running turn record as interrupted with a finish timestamp. Recovery
  repairs legacy rows whose thread is already interrupted but whose turn record
  is still active; it never records an uncertain send as completed.
  Recovery never resends a user message and surfaces the interruption as new
  unread activity. `thread/read` confirms whether the provider conversation
  still exists; if it reports an active provider turn, a new prompt is blocked
  until that turn is no longer active. If `thread/read` returns `notLoaded`, an
  explicit history check resumes the same saved provider ID, then reads status
  again. It never starts a replacement conversation. `active`, `systemError`,
  `notLoaded`, unknown, missing, and unavailable states remain distinct and
  gated unless a fresh read confirms a sendable idle state. Before an explicit
  follow-up, the backend reconciles every provider turn and item through
  paginated `thread/turns/list` and `thread/items/list`. History is merged by
  stable provider item ID. Each local send attempt is correlated with
  `clientUserMessageId` and the provider's returned user item `clientId` before
  local echo merging. Text-only matches never prove that the current attempt
  was accepted; an older identical prompt is outside the send's captured
  baseline. The durable outcome is `confirmedPresent`, `confirmedAbsent`, or
  `ambiguous`. A confirmed present prompt blocks an unchanged duplicate but
  permits a different follow-up when Codex is idle. A confirmed absent prompt
  remains in the composer and requires an explicit user retry. Ambiguous or
  unavailable history remains gated. Provider text cannot prove attachment
  acceptance, which stays `unknown` when the send included attachments. No
  uncertain prompt is automatically replayed. Replayed history that does not
  change the normalized transcript does not advance activity cursors. If read,
  pagination, or resume is unavailable, local display history remains saved
  and follow-up stays blocked. History reconciliation is capped at 256 page
  requests and 120 seconds; exceeding either bound also blocks the follow-up.
- Each accepted send has a durable `ChatTurnRecord` keyed by its client attempt
  ID. It stores the provider turn ID when known, model/effort/auto-accept
  settings, effective approval/sandbox values returned by `thread/start` or
  `thread/resume`, reconciliation outcome, and completed/interrupted/failed
  state. Startup converts claimed or active turns to interrupted. History
  reconciliation does not rewrite that known interruption as completion.
  Fields were added with serde defaults to thread JSON. SQLite user version 8
  adds folder-instance and attachment-project scope. If Codex omits an
  effective policy value, it remains unknown. Chat
  does not send approval or sandbox overrides to `thread/start`, `thread/resume`,
  or `turn/start`. Explicit auto-accept only accepts an approval decision that
  Codex offered; it does not broaden the configured sandbox.
- Modern command and file-change approvals require an exact base decision from
  Codex's `availableDecisions` list. Policy-amendment choices are unsupported:
  Chat hides them, explains the limitation, and permits only an offered base
  decision or stopping the turn. If Codex omits the offered list or offers only
  unsupported decisions, Chat provides no invented approval response; the
  backend also rejects it. Legacy approval methods use their fixed protocol
  decision set.
- Agent Chat holds at most four live Codex child processes globally, including
  temporary model/history probes. Capacity is reserved before process launch
  and released when launch fails or the child exits. This keeps independent
  conversations concurrent while applying a clear backpressure error at the
  internal limit; there is no user-facing capacity setting.
- Agent Chat requires Codex CLI 0.162.1 or newer. The baseline is checked before
  starting app-server. For the Phase 0 protocol review, installed Codex CLI
  0.163.0 generated TypeScript schema into a temporary directory. It confirms
  `serverRequest/resolved` has `{ threadId: string, requestId: string | number }`
  and model entries expose `inputModalities`. The same generated schema was
  used for turn `clientUserMessageId`, returned user item `clientId`, and
  thread response effective `approvalPolicy`/`sandbox` fields. The schema
  evidence and scope are recorded in
  [agent-chat-protocol-evidence.md](agent-chat-protocol-evidence.md).
  This is generated-schema evidence, not a live native protocol acceptance.
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
