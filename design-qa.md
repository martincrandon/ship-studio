# Agent Chat design QA

**Findings**

The earlier harness captures showed no actionable P0/P1/P2 visual differences in the empty-draft view. The composer hierarchy, prompt entry, model and reasoning controls, attachment action, Send action, and checkout scope read clearly in the Agent dock. Ship Studio keeps its own token palette and shared icons. The source uses a spacious standalone workspace with a purple Send action; the implementation intentionally adapts it to the narrower existing Agent panel and Ship Studio's green accent.

**Latest code corrections (2026-10-14)**

- Agent header navigation is now accessible icon-only Terminal and Chat tabs; there is no Default button.
- Model and reasoning selections carry into a new draft and persist per project. The composer has inset spacing, a larger corner radius, 14px prompt text with a more open line height, and image thumbnail previews. The Current checkout button sits 4px below the composer and its menu opens upward; New Conversation has matching top and left insets.
- Screenshot capture uses the Preview footer's camera action and Crop action. Viewport and crop attachment routing remains tied to the initiating draft and checkout rules documented in [docs/agent-chat.md](docs/agent-chat.md).
- Source inspection records model and reasoning carry-forward, image thumbnail previews, inset composer spacing, and larger prompt text. The latest empty-draft fixture capture confirms visible composer side gutters, icon-only Terminal/Chat tabs with no Default button, removal of the left gray strip, and one camera action plus Crop in the footer. It does not verify thumbnail rendering or model carry-forward.
- The latest fixture-backed capture confirms the visible composer side gutters and larger radius, icon-only Terminal/Chat tabs with no Default button, no left gray strip, one Full Screenshot action plus Crop, the checkout gap, and matching New Conversation insets. It does not verify thumbnail rendering or model carry-forward behavior. The currently attached preview is a website, not the Tauri app, so it provides no native Tauri/WKWebView or live Codex verification.
- Scoped ESLint, Prettier, and `git diff --check` passed after these changes. Earlier responsive/model captures and the TypeScript and focused hook-test results below are prior evidence, not verification of the latest behavior.

**Evidence**

- Source visual: `/Users/martincrandon/.t3/userdata/attachments/a39c48e8-e17c-4787-8cf7-cdd8a0dacbc8-29a782d6-633a-470d-b506-013783781f42.png` — 2388×2380 px. Its original CSS viewport and device scale are unavailable; no density normalization was applied.
- Rendered empty draft: `/tmp/shipstudio-agent-chat-minimal/agent-chat-empty-draft.png` — captured by the repo harness with a configured 1440×900 browser window and deviceScaleFactor 2; output is 2880×1514 px. The window dimensions include browser chrome and are not a measured CSS content viewport. Source and implementation have intentionally different content widths; no claim of pixel alignment is made.
- Latest empty-draft fixture capture: `/tmp/shipstudio-agent-chat-refinement/agent-chat-empty-draft.png` — settled after the latest source fixes and inspected for the side gutters, Agent header tabs, removed left gray strip, and footer camera/Crop actions described above. This capture does not show or establish image-thumbnail rendering or new-draft model carry-forward behavior.
- Existing attachment fixture capture: `/tmp/shipstudio-agent-chat-refinement/agent-chat-attachment.png` — shows an image attachment in a sent transcript message; it does not exercise a staged image preview in the composer.
- Focused comparison: `/tmp/shipstudio-agent-chat-minimal/empty-comparison.png` places the source's headline/composer crop beside the implementation's Agent panel crop. The shells and available widths differ by design, so the comparison evaluates hierarchy and composer density rather than pixel alignment.
- Functional rendered states: `/tmp/shipstudio-agent-chat-minimal/agent-chat-streaming.png` shows the selected fixture conversation, partial assistant response, tool activity, and Stop; `agent-chat-approval.png` shows the exact command, working directory, and Allow/Decline actions. Both harness scenarios passed their required-selector checks.
- The empty-draft capture has no Chat component exception. Harness console output includes expected fixture-environment messages for the dev server, Nerd Fonts, and terminal PTY startup.
- Responsive verification used the repo harness with its identity check intact and a temporary external CDP runner. The runner set the Agent surface to 260, 320, and 420 CSS px; the chat content measured 252, 312, and 412 px after the surface border. At each width, the empty composer and streaming-thread composer stayed above the checkout footer, the checkout footer ended at the pane bottom, and Model, Reasoning effort, Attach files, and Send shared one vertical center line with no horizontal overflow. The 260 px empty and active captures are `[/tmp/shipstudio-agent-chat-controls/width-260-empty/agent-chat-empty-draft.png](/tmp/shipstudio-agent-chat-controls/width-260-empty/agent-chat-empty-draft.png)` and `[/tmp/shipstudio-agent-chat-controls/width-260-active/agent-chat-streaming.png](/tmp/shipstudio-agent-chat-controls/width-260-active/agent-chat-streaming.png)`; 320 and 420 captures are in the corresponding `width-320-*` and `width-420-*` folders. These CSS surface-width probes leave the surrounding fixture column at its original width, so blank space beside the panel is a harness artifact.
- A narrow long-label fixture used the existing `GPT-5.4 Codex` model name and an explicitly synthetic alternate label to exercise selection and truncation. Both model and effort menus opened through their custom menu items; selecting the alternate model and `high` effort updated their trigger labels. At 260 px, the selected model label showed 106 px of 396 px and ellipsized, while the chevron and fixed action buttons remained visible with no toolbar overflow. Keyboard opening placed focus on the first menu item, ArrowDown moved focus to the next model, Escape restored focus to the trigger. See `[/tmp/shipstudio-agent-chat-controls/width-260-long-label/agent-chat-long-model-label.png](/tmp/shipstudio-agent-chat-controls/width-260-long-label/agent-chat-long-model-label.png)` and the focus details in `[/tmp/shipstudio-agent-chat-controls/width-260-keyboard/report.json](/tmp/shipstudio-agent-chat-controls/width-260-keyboard/report.json)`.
- A scoped TypeScript compile covering `AgentChatPanel.tsx`, `WorkspaceTerminalPane.tsx`, and `agentChat.ts` passed. The responsive captures are fixture-backed and do not verify native Codex app-server startup or a live first conversation.

The conversation/thread states use fixtures. Native Codex app-server startup and a live first conversation remain unverified; [docs/agent-chat.md](docs/agent-chat.md) records that boundary. No follow-up P3 polish is needed from this comparison.

**Fidelity and iteration history**

- Typography and copy: existing Ship Studio sans-serif tokens provide a short heading, readable placeholder and compact control labels. The text is adapted to a project Agent panel; it does not repeat implementation details in the empty state.
- Layout and tokens: the composer is now anchored at the bottom in both empty and active states, with model/effort and attachment/send controls on one row and checkout below. Ship Studio's gray surfaces and green action are intentional product constraints.
- Asset quality: shared vector icons remain sharp; no decorative raster asset is required for this chat-only reference.
- Earlier P1 density mismatch: stacked headers, permanent warnings and a create-first screen were removed. Earlier P2 Send-button distortion was fixed by equal tokenized width and height; the latest empty capture shows a circular button and a single thin focus border. Root inspected that revised capture along with the source, streaming and approval captures; no further visual fix was required.

**Implementation Checklist**

- [x] Empty draft remains local until Send.
- [x] Agent-panel composer adapts the reference hierarchy to Ship Studio's existing panel and tokens.
- [x] Streaming and approval fixture states render and pass harness subject checks.
- [x] Prior scoped TypeScript, ESLint, Prettier, and focused screenshot hook checks passed; latest scoped ESLint, Prettier, and `git diff --check` passed after the code corrections.

Latest status: limited fixture-backed visual confirmation and scoped lint/format/diff checks passed. Image-thumbnail rendering, model carry-forward, and native Tauri/Codex behavior remain unverified.
