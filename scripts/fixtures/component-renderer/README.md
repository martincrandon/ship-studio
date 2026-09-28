# Component renderer fixtures

These fixtures are deterministic inputs for adapter planning, protocol tests,
and bounded runtime smoke checks. CI does not install dependencies by default;
the pinned package manifests keep an explicit fixture install reproducible.
Each fixture covers a named/default export, a client-side
component, finite/static props, plain-text children, global CSS, a CSS Module,
an explicit provider/decorator candidate, a public asset, and a controlled
error component.

The Next App Router fixture exercises `app/layout.tsx` inheritance. The Next
Pages Router fixture exercises `_app.tsx`. The Vite fixture includes an alias
in `vite.config.ts`, but remains catalog-only until a reviewed Vite plugin/config
contract exists. HMR, route reachability, memory/CPU, and platform behavior are
runtime acceptance checks and are not inferred from these files.

## Generated-host smoke acceptance

Run the focused DOM/browser-like acceptance for both pinned Next fixtures with:

```bash
pnpm test:run -- src/lib/components/next-renderer-fixture.test.tsx
```

The smoke compiles the generated Next client shell and mounts it in jsdom around
the App Router and Pages Router Card markup. It exercises root-scoped tree and
dirty refresh, direct/tree/hover round trips, cascade read-only inspection,
text/structure gates, class/CSS previews, HMR reselect, exact identity and
source-boundary rejection, cleanup, and the six-live-frame lifecycle bound. It
does not install or start either fixture app.
