# 002 — Mobile component runtime integrations

Status: DONE for the source-contract and host-bridge slice. This plan does not
claim that a native app was built in CI; the device/simulator matrix below is a
release validation procedure for a machine with the corresponding toolchain.

This is deliberately a separate plan from [001-native-components](./001-native-components.md).
React Native/Expo and Flutter do not render a browser DOM, so their runtime
identity must never be routed through Ship Studio's `ss:*` iframe protocol or
converted into an Element Tree boundary from pixels.

## Acceptance checklist

- [x] Define a versioned, bounded native provenance envelope.
- [x] Require an explicit host-issued session token and bridge session.
- [x] Validate renderer, project-relative source paths, UTF-8 ranges, and
  complete source hashes before accepting a binding.
- [x] Keep definition-only data `sourceAnchored`; accept `exact` only when the
  invocation range matches exactly one indexed usage.
- [x] Provide a React Native/Expo emitter seam suitable for an opt-in Metro or
  React Native DevTools integration without depending solely on private React
  internals.
- [x] Keep React Native source-only placement/static props on their own parser
  and Rust graph-guard token; native visual writes remain disabled.
- [x] Provide a Flutter analyzer payload contract and Widget Inspector/VM
  Service host bridge seam; Flutter source records are analyzer-owned rather
  than parsed by Rust or a handwritten Dart parser.
- [x] Clear active bindings on reload, route change, disconnect, and bridge
  disposal.
- [x] Refuse unsupported protocol versions, renderer mismatches, stale hashes,
  path traversal, unknown sessions, missing invocations, and ambiguity.
- [x] Add deterministic simulator/device-shaped fixtures for both renderers.

## Runtime contract

The implementation is in:

- `src/lib/components/mobile-runtime.ts`
- `src/lib/components/flutter-analyzer.ts`
- `src/lib/components/mobile-runtime.test.ts`

Protocol version `1` has three messages:

1. `hello` authenticates one explicitly configured renderer/runtime session;
2. `boundary` carries a definition source range and, when available, an exact
   invocation source range;
3. `clear` removes one runtime identity or the complete session.

All ranges use UTF-8 byte offsets and complete SHA-256 file hashes, matching
the web component mutation contract. The host derives component and instance
IDs from the current immutable index. It never trusts a runtime-provided name,
ID, DOM coordinate, tree order, screenshot, or prop value as identity.

`createMobileRuntimeEmitter` is transport-neutral so a project-side opt-in
Metro transform, React Native DevTools adapter, or Flutter integration can send
the same messages over its supported local debugging channel. The emitter does
not install packages, alter project files, open a socket, or execute project
code on Ship Studio's behalf.

`createMobileRuntimeBridge` is the host validator. It returns a mobile binding,
not a `ComponentBoundary`: native mirrors have no DOM host node and therefore
cannot hide children or create a web Element Tree row. A definition-only event
is useful for source navigation but remains `sourceAnchored`; an exact
invocation is the only event eligible for exact instance actions in a future
native inspector surface.

## React Native / Expo integration

The project-side integration is opt-in and development-only. A Metro/DevTools
adapter should:

1. obtain a host-issued token and opaque bridge session from Ship Studio;
2. emit `hello` after the debug runtime is ready;
3. emit definition ranges from the transform/source map and invocation ranges
   only when the transform can prove them;
4. emit `clear` on Fast Refresh, route replacement, app reload, disconnect, and
   unmount; and
5. close its transport when the DevTools target disappears.

React Native DevTools is the supported debugging surface for current React
Native releases; Ship Studio must not assume legacy remote-JavaScript-debugging
behavior. A future transport can use the documented DevTools/CDP connection,
but the source-hash validation in this plan remains the authority.

## Flutter integration

The Dart Analysis Server owns parsing, package resolution, declarations, and
source ranges. `buildFlutterComponentIndex` consumes its versioned records only
after validating them against the current Ship Studio source snapshot. The
initial supported analyzer major is `3.x`; another major requires an explicit
protocol/fixture update.

The Widget Inspector/VM Service adapter should:

1. pair with the analyzer snapshot for the same workspace and source hashes;
2. map an inspector reference to an analyzer definition and, only when proven,
   an invocation range;
3. send the resulting `boundary` event through the same authenticated bridge;
4. clear references after hot reload, route change, VM disconnect, or app exit;
   and
5. leave unpaired or source-stale inspector nodes source-only.

No Flutter identity is inferred from a screenshot, render-box coordinate, widget
label, or inspector traversal order.

## Security and lifecycle

- Tokens are generated by the host per preview session and are not persisted in
  the component index or analytics.
- Incoming messages are bounded to 64 KiB; strings, IDs, sessions, and routes
  are bounded to 256 characters; only the single declared capability is
  accepted.
- Paths reject NULs and traversal segments and are normalized against the
  active project/workspace before index lookup.
- Source ranges require safe integers, positive line/column data, and a
  64-character lowercase SHA-256 hash. A same-range/different-hash event is
  classified as stale, never rebound.
- The bridge accepts only the configured renderer and token, requires `hello`
  before data, and refuses session changes until the host creates a new bridge.
- `dispose()` clears active state and sends one disconnect message from the
  emitter. Host project/window teardown must call bridge disposal as part of
  the native preview session cleanup.
- No source text, tokens, runtime IDs, or absolute paths are sent to analytics.

## Compatibility and verification

The focused contract suite is:

```text
pnpm exec vitest run src/lib/components/mobile-runtime.test.ts
```

It covers:

- React Native exact and definition-only bindings;
- authentication, session, renderer, stale-source, traversal, and ambiguity
  refusals;
- Flutter analyzer source validation plus Widget Inspector exact binding; and
- emitter cleanup and post-disposal behavior.

The release device/simulator matrix is intentionally explicit:

| Renderer | Target | Required observation |
| --- | --- | --- |
| React Native/Expo | iOS Simulator, Hermes development build | hello, one exact boundary, Fast Refresh clear, reconnect |
| React Native/Expo | Android Emulator, Hermes development build | same source/hash behavior over the Android DevTools transport |
| Flutter | iOS Simulator, debug/profile VM Service | analyzer pairing, Widget Inspector exact binding, hot-reload clear |
| Flutter | Android Emulator, debug/profile VM Service | same pairing/clear behavior and refusal after stale source |

The current repository test does not pretend to complete those multi-minute
native builds. It provides deterministic transport-shaped evidence; the matrix
is the operator checklist before advertising a live mobile runtime binding.

## References

- [React Native DevTools](https://reactnative.dev/docs/react-native-devtools)
- [React Native debugging](https://reactnative.dev/docs/debugging.html)
- [Flutter WidgetInspector](https://api.flutter.dev/flutter/widgets/WidgetInspector-class.html)
- [Dart VM service protocol](https://api.dart.dev/dart-developer/ServiceProtocolInfo-class.html)
