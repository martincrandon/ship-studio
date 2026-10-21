# Agent Chat protocol evidence

## Local generated schema

- Installed CLI: `codex-cli 0.163.0` (`codex --version`).
- Generation: `codex app-server generate-ts --out <temporary-directory>`.
- Official protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
- Inspected generated types, with no full schema bundle committed:
  - `v2/ServerRequestResolvedNotification.ts` declares
    `{ threadId: string, requestId: RequestId }`.
  - `RequestId.ts` declares `RequestId = string | number`.
  - `v2/Model.ts` declares `inputModalities: Array<InputModality>`;
    `InputModality.ts` lists `text | image | audio`.
  - `v2/TurnStartParams.ts` exposes `clientUserMessageId`, and the returned
    `v2/UserMessage` item exposes `clientId` for correlating accepted prompts
    with their originating send attempt.
  - `v2/ThreadStartResponse.ts` and `v2/ThreadResumeResponse.ts` expose the
    effective `approvalPolicy` and `sandbox` values when the provider returns
    them. These values are treated as unknown when absent.

## Ship Studio behavior

Server request resolution matches the originating Ship Studio thread, runtime
generation, provider thread ID, and typed JSON-RPC request ID. Numeric and string
IDs remain distinct. Duplicate or late resolutions have no effect on a newer
request. Unknown notifications produce at most one neutral activity item per
runtime; known status and token-usage notifications are ignored, and raw
notification parameters are not saved.

Send attempts use `clientUserMessageId` and match only the returned `clientId`
or a previously bound provider turn ID as acceptance evidence. Prompt text is
not used to claim that an attempt was accepted. Turn starts carry no approval
or sandbox overrides; Chat records effective provider-returned values for
display and per-turn history.

Model input modalities are preserved from `model/list`. Missing or malformed
capabilities remain unknown. When a discovered selected model explicitly omits
`image`, Ship Studio blocks sending staged image attachments in the composer
and validates again in Rust before accepting the turn.

## Evidence limits

This records installed CLI version and generated source schema only. It does
not establish the shape of a live account-specific `model/list` response or
prove native app-server request-resolution behavior. Harness fixtures are
synthetic; native protocol acceptance remains outstanding.
