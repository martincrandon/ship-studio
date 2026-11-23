# Agent Chat bounded native smoke evidence

Observed 2026-10-20 UTC. **Native smoke blocked at the isolation preflight; no build or app launch was attempted.** No product/source edits, tests, suites, commits, or pushes were performed.

## Source provenance

- Checkout `HEAD`: `34ef21f8aebb2a738f47314d082c469f93a45783`.
- The checkout was already dirty with concurrent Agent Chat and unrelated source changes. This task did not modify those files.
- Content digest of `src/`, `src-tauri/src/`, and `public/` at preflight: SHA-256 `52e7729c2564b21dce4d4e8b75b7593638354263cc1358347bbc873fc209ce40` (hash over sorted per-file SHA-256 records).
- Content digest of package manifests, Rust manifests/lockfile, Tauri config, and `build.rs`: SHA-256 `8295e0d545e68d75f8f1b1a4e414d3fae07be2ea5a2044bab841715d46728c78` (hash over sorted per-file SHA-256 records).
- **Built source state: none.** Existing installed/debug binaries and the already-running Ship Studio processes were not used as evidence for this checkout.

## Isolation preflight and blocker

- The checked-in Tauri config uses identifier `com.memberstack.shipstudio` and dev port `1420` ([`tauri.conf.json`](../src-tauri/tauri.conf.json#L3-L8)). `ChatStore::open` stores Chat data beneath `app.path().app_data_dir()/agent-chat` ([`persistence.rs`](../src-tauri/src/commands/agent_chat/persistence.rs#L40-L50)). The uncreated candidate overlay used identifier `com.memberstack.shipstudio.smoke.p0p2.20261020t1516` and port `1427`; the anticipated macOS app-data namespace `~/Library/Application Support/com.memberstack.shipstudio.smoke.p0p2.20261020t1516` was absent, and port `1427` had no listener. This is static/preflight evidence only; the resolved path was not runtime-confirmed.
- The application settings file is **not identifier-scoped**: on macOS `get_app_state_path()` resolves to `~/Library/Application Support/ShipStudio/app_state.json` ([`state.rs`](../src-tauri/src/commands/setup/state.rs#L12-L19)). Startup calls `init_analytics()` before creating the Tauri app; that routine writes the global AppState if it has no `device_id` ([`lib.rs`](../src-tauri/src/lib.rs#L128-L134), [`analytics.rs`](../src-tauri/src/commands/analytics.rs#L30-L48)). The pins file is also a fixed global path (`~/Library/Application Support/ShipStudio/pins.json`) ([`pins.rs`](../src-tauri/src/commands/projects/pins.rs#L1-L10)).
- Therefore a unique identifier overlay would isolate Agent Chat storage but **would not isolate the app configuration**. Launching could read or mutate existing user settings, so the required safety condition was not met. I stopped before creating an overlay, scratch account copy, project, or build.

## Bounded outcome

- Native app build/launch: **not attempted** (safety gate failed; 0 seconds spent building/launching).
- Composer, history, and model controls: **not observed**. No native window from this task was opened.
- Submitted prompts: **0**. No provider turn, login flow, or API key flow occurred.
- Screenshots: **none**.
- Cleanup: no scratch secrets/config, overlay, or project were created; no process was launched or stopped. Existing Ship Studio processes were left untouched. The only CUA action was a read-only inventory showing the installed Ship Studio app already running; the app was not selected, interacted with, or captured. That observation has no source provenance and is not native Chat acceptance.

## Prerequisite for a safe retry

Use an isolated runtime home/config path that also redirects the fixed AppState and pins locations, or add an approved test-only path override and verify it before startup. Then rebuild and verify the exact source snapshot before using native UI automation.

## Second bounded native smoke attempt

Observed 2026-10-20 UTC. The user authorized normal startup/lifecycle side effects to the existing AppState and pins, provided that the Chat database and project edits were isolated. This supersedes the self-imposed all-config isolation gate recorded above.

### Source and launch provenance

- Checkout `HEAD`: `34ef21f8aebb2a738f47314d082c469f93a45783`; the working tree remained dirty with concurrent changes.
- Content digest of `src/`, `src-tauri/src/`, and `public/` immediately before build: SHA-256 `9235095496534d9b5a0d9af824c172a2076bdd26b96f4d0cb236ecd736623c82` (hash over sorted per-file SHA-256 records).
- Content digest of package manifests, Rust manifests/lockfile, Tauri config, and `build.rs`: SHA-256 `99f36e55d471b8c06fb10622f823183b7a5bfb5f46f73e3a522b95ab71bfd9d7` (same method).
- Ran `pnpm tauri dev --config /tmp/shipstudio-chat-smoke-p0p2-20261020t1516/tauri-smoke.json` with a private `CODEX_HOME` containing mode-0600 copies of the existing `auth.json` and `config.toml`; credential contents were not printed. The overlay used product name `Ship Studio Smoke P0P2 1516`, identifier `com.memberstack.shipstudio.smoke.p0p2.20261020t1516`, and dev URL/port `http://127.0.0.1:1427`.
- One initial dev invocation stopped before compilation because an extra `--` caused Vite to target occupied port 1420. The corrected invocation reported Vite ready on port 1427, compiled the current checkout, and launched `target/debug/ship-studio`; Cargo reported `Finished dev profile` in 11.05 seconds. This was a source build, not the installed app or the stale pre-existing debug binary.
- The unique app-data directory appeared at `~/Library/Application Support/com.memberstack.shipstudio.smoke.p0p2.20261020t1516` and contained `agent-chat/threads.sqlite3`, confirming runtime Chat storage used the unique app identifier.

### Concrete blocker and bounded outcome

- The launched window's frontend logs identified its origin as `http://127.0.0.1:1420` (including event-listener warnings), while this attempt's private Vite command was configured for 1427 and reported ready there. That mismatch means the window was not proven to load this checkout's frontend module. CUA inventory also exposed only the installed `Ship Studio` bundle, not a uniquely targetable smoke window. I did not type into or interact with an ambiguous window, and stopped the attempt.
- Startup analytics were enabled. The app log reported `app_launched` and `$pageview` accepted with HTTP 200, then `$identify` with distinct ID `martincrandon`. This was a normal startup side effect; no login, credential flow, or settings UI was used. `app_state.json` had no `device_id` before or after this attempt.
- Native Chat composer, saved drafts, model controls, image attachment flow, text/tool turn, interrupt, and restore behavior remain **unobserved**. Submitted prompts: **0**. Screenshots: **none**. No native Chat acceptance is claimed.
- Stopped the dev process and its own children. The pre-existing installed app process was left untouched. Removed only this attempt's disposable project, private overlay/Codex copies, and the unique app-data directory. No source files or shared settings were edited/restored; no tests, full suites, commits, or pushes were run.

## Third native smoke attempt — overlay provenance repaired, acceptance incomplete

Observed 2026-10-20 UTC. This attempt resolved the prior Vite-port mismatch and made a uniquely titled window targetable. It did **not** reach Agent Chat; no prompt was submitted. The requested five-minute wall-clock cap was exceeded during launch-target troubleshooting, so acceptance stopped at the dashboard/New Project modal. No product source was edited, no tests or suites were run, and no commits or pushes were made.

### Source and private launch provenance

- Checkout `HEAD`: `34ef21f8aebb2a738f47314d082c469f93a45783`.
- Source digest of `src/`, `src-tauri/src/`, and `public/`: SHA-256 `9235095496534d9b5a0d9af824c172a2076bdd26b96f4d0cb236ecd736623c82` (sorted per-file SHA-256 records). It matched the digest recorded for attempt 2.
- Build/config digest of `package.json`, `pnpm-lock.yaml`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, and `vite.config.ts`: SHA-256 `bab1d1eb9142ac7e8a5975a04181424f244415de4ab9caccffca9565ac662ab9` (sorted per-file SHA-256 records).
- Debug executable SHA-256 after the successful overlay build: `2ea4cf9de2e51072d1516ed97dddf7d2f979728d73f9963ac241292c8785e395` (`src-tauri/target/debug/ship-studio`).
- Inspection found the root cause of attempt 2: `vite.config.ts` chooses its listener from `SHIPSTUDIO_DEV_PORT`, and `src-tauri/src/lib.rs::main_webview_url()` independently chooses the dynamically built main window URL from the same environment variable, defaulting to 1420. The programmatic main window does not consume `build.devUrl`; changing only that config value cannot move it. The inspected `src-tauri/build.rs` only calls `tauri_build::build()` and adds no runtime port override. Tauri’s CLI merges `--config` JSON and file overlays in order (verified with `pnpm tauri dev --help`).
- Tauri creates configured `app.windows` entries before the app setup callback. A private configured window can therefore coexist with the source-created `main` window. An explicit HTTP `url` on that configured window was used to remove any ambiguity about the frontend origin. Its label must match the existing `window-*` capability pattern. The first attempt used a label outside that pattern and produced eight capability warnings; it was stopped before any UI input. The corrected label had no `not allowed on window` warnings.

### Effective private overlay

The disposable overlay at `/tmp/shipstudio-agentchat-p02-20261020t1657/tauri-smoke.json` was:

```json
{
  "productName": "Ship Studio Agent Chat Smoke 20261020T1657",
  "identifier": "com.memberstack.shipstudio.smoke.agentchat.p02.20261020t1657",
  "build": { "devUrl": "http://127.0.0.1:1431" },
  "app": {
    "windows": [
      {
        "label": "window-agentchatacceptance20261020t1657",
        "title": "Agent Chat Smoke 20261020T1657",
        "url": "http://127.0.0.1:1431",
        "create": true,
        "center": true,
        "width": 1400,
        "height": 900
      }
    ]
  }
}
```

Private Codex `auth.json` and `config.toml` were copied to `/tmp/shipstudio-agentchat-p02-20261020t1657/codex-home/` with mode `0600`; the source credentials were not printed. The bundle wrapper exported that private `CODEX_HOME` and `SHIPSTUDIO_DEV_PORT=1431`, then exec’d the already-built checkout binary. The bundle path used for CUA was `/tmp/shipstudio-agentchat-p02-20261020t1657/Ship Studio Agent Chat Smoke 20261020T1657.app` and its `CFBundleIdentifier` matched the overlay identifier.
Its `Contents/MacOS/run-smoke` wrapper was:

```sh
#!/bin/sh
cd "/Users/martincrandon/Desktop/Development/Ship Studio/ship-studio/src-tauri"
export SHIPSTUDIO_DEV_PORT=1431
export CODEX_HOME="/tmp/shipstudio-agentchat-p02-20261020t1657/codex-home"
exec "/Users/martincrandon/Desktop/Development/Ship Studio/ship-studio/src-tauri/target/debug/ship-studio" >> "/tmp/shipstudio-agentchat-p02-20261020t1657/bundle.log" 2>&1
```

Commands used:

```bash
CODEX_HOME=/tmp/shipstudio-agentchat-p02-20261020t1657/codex-home SHIPSTUDIO_DEV_PORT=1431 pnpm tauri dev --no-watch --config /tmp/shipstudio-agentchat-p02-20261020t1657/tauri-smoke.json
SHIPSTUDIO_DEV_PORT=1431 pnpm dev
# CUA opened the private wrapper bundle path above, which ran src-tauri/target/debug/ship-studio.
```

The first command compiled in 17.27s with the wrong window label, then again in 14.27s with the corrected label. Both reported Vite ready at `http://127.0.0.1:1431/`. The separate Vite server used for the CUA-targetable bundle reported the same URL; `curl -I` returned `HTTP/1.1 200 OK`. `lsof` showed the Vite listener (PID 63923) with working directory `/Users/martincrandon/Desktop/Development/Ship Studio/ship-studio`. The native window’s accessibility tree independently reported `URL: 127.0.0.1:1431/`.

### Native UI evidence and outcome

- `cua.getState()` did not list the Cargo-launched debug app. Creating the private `.app` wrapper let CUA bind by its exact bundle path; `cua.listApps()` then showed the private identifier `com.memberstack.shipstudio.smoke.agentchat.p02.20261020t1657`, distinct from the installed `com.memberstack.shipstudio` app.
- CUA read the uniquely titled native window `Agent Chat Smoke 20261020T1657` in app `Ship Studio Agent Chat Smoke 20261020T1657`. Its page was the real checkout frontend at port 1431.
- The dashboard rendered and showed six pre-existing user projects. None was opened or modified. The New Project modal rendered. Searching the command palette for “register” returned no matching action; no project was registered or created.
- Relevant native accessibility text: `Window: "Agent Chat Smoke 20261020T1657"`; `HTML content Description: Ship Studio, URL: 127.0.0.1:1431/`; dashboard heading `What will you Ship today?`; New Project modal heading `New Project`; command search result `No matches for "register"`.
- A disposable plain `index.html` folder was created at `/tmp/shipstudio-agentchat-p02-20261020t1657/project/`, but it was never opened or registered. It was removed during cleanup.
- No Chat panel, composer, history, draft, model control, image picker, tool invocation, streaming, follow-up, stop, restart, or thread-isolation behavior was reached. Submitted prompts: **0**. No approval or question prompt occurred. No screenshots were saved; the native accessibility state above is the UI evidence.
- Startup analytics were enabled. Across the three process starts in this attempt, each emitted two `app_launched`, six `$pageview`, and four `$identify` events; all logged PostHog responses were HTTP 200. This totals six `app_launched`, 18 `$pageview`, and 12 `$identify` events. No sign-in, permission, or settings UI was used.

### Cleanup and remaining acceptance

- Stopped the private Tauri/Vite sessions and the private smoke app process only. The installed Ship Studio app (PID 5874, `/Applications/Ship Studio.app/Contents/MacOS/ship-studio`) remained running and untouched.
- Removed the unique app-data directory `~/Library/Application Support/com.memberstack.shipstudio.smoke.agentchat.p02.20261020t1657`, the disposable project, temporary `.app` wrapper, private credential copies, overlay, and captured scratch logs. Shared AppState/pins were not snapshot-restored or edited through settings; startup analytics/logging side effects described above were left as generated.
- Native acceptance remains pending: open a disposable registered plain folder, inspect Agent Chat composer and saved-draft restoration, then exercise streaming and a follow-up within the two-prompt cap. Thread isolation, stop/restart, history, and optional image/tool behavior also remain unobserved.
