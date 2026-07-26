# Ship Studio Design System

The reference for tokens and UI primitives. Audience: you're about to build a feature and need
the right token or component in under a minute. Canonical sources (always trust these over docs):

- Tokens: the `:root` block at the top of [src/styles/global/base.css](../src/styles/global/base.css)
- Primitives: [src/components/primitives/](../src/components/primitives/)
- The rules and rationale: [CLAUDE.md → How to Do Things in Ship Studio](../CLAUDE.md#how-to-do-things-in-ship-studio)
  and [docs/CONTRIBUTING_PATTERNS.md](CONTRIBUTING_PATTERNS.md)

## Design tokens

The current styling baseline is the Ship Studio Figma Variables system. The token file is split
into two layers:

| Layer | Naming | Rule |
| --- | --- | --- |
| Primitive | `--color-*`, `--space-*`, `--radius-*`, `--stroke-*`, `--font-*` | Raw imported palette, scale, type, and effect ingredients. Use from semantic definitions, not directly in feature CSS. |
| Semantic | `--surface-*`, `--text-*`, `--border-*`, `--accent-*`, `--button-*` | Application-facing roles. Components and feature styles should use these. |

Representative Figma mappings are `background-app → surface-app`, `background-panel →
surface-panel`, `background-control → surface-control`, `background-selected →
surface-selected`, `border-subtle → border-subtle`, `accent-active → accent-active`, and
`size-radius-control → radius-control`. Figma text/effect styles are mapped into semantic
typography and shadow tokens rather than treated as primitives.

### Token migration inventory

The migration inventory is deliberately conservative. Exact imports and obvious semantic
reattachments are automated; unresolved values remain explicit and are marked for review.

| Source | Classification | Code treatment |
| --- | --- | --- |
| Figma color, spacing, radius, stroke, and type Variables | Exact | Imported into `--color-*`, `--space-*`, `--radius-*`, `--stroke-*`, and `--font-*` primitives. |
| Figma `background-*`, `text-*`, `border-*`, and `accent-*` Variables | Obvious semantic | Reattached to category-first `--surface-*`, `--text-*`, `--border-*`, and `--accent-*` roles. |
| Figma `Body M/Regular`, `Body S/Regular`, `Code S/Regular`, `Button Effects`, `Input inner shadow`, and `Window shadow` styles | Obvious semantic | Exposed through `--font-ui`, `--font-code`, `--shadow-button`, `--shadow-input-inset`, and `--shadow-window`; these are not primitives. |
| Legacy `--bg-*`, `--accent`, `--action`, `--border`, `--warning`, `--success`, `--error`, and `--font-mono` names | Compatibility | Kept as deprecated aliases in the compatibility section only; product usages are reattached to semantic roles. |
| Existing error palette (`#f44747`, `#ef4444`, `#dc2626`) | Ambiguous / review | Retained as explicit `--color-red-error*` values because no corresponding Figma semantic was observed. |
| Feature-local info, purple, Slack, ANSI, and code-syntax colors | Feature semantic | Preserved where their product meaning is specific; do not use them as general surface or text roles. |
| Terminal colors and icon/symbol typography | Platform/component input | xterm keeps explicit canvas colors; Geist Mono is used for code, while JetBrains Mono Nerd Font is retained for glyph coverage. |
| Button `default`, `primary`, `secondary`, `danger`, `ghost`, `warning`, and `variable` states | Obvious semantic | `default` is the Figma neutral solid role, `secondary` is neutral outline, `warning` is amber, and `danger` remains destructive red. |

This pass imports the current dark application mode. Other Figma modes remain part of the source
inventory but are not wired into the application yet.

All defined in the `:root` block of `base.css`. Never write raw hex colors, raw spacing px, raw
z-index numbers, or raw durations in CSS — use a token (CI enforces colors; review enforces the rest).

| Group | Tokens | When to use |
| --- | --- | --- |
| Surfaces | `--surface-app` / `--surface-panel` / `--surface-control` / `--surface-selected` / `--surface-recessed` | App background → panels → controls → selected rows; recessed wells are used for terminals, log output, and code editors. |
| Text | `--text-primary` / `--text-secondary` / `--text-muted` / `--text-faint` / `--text-terminal-strong` | Default → supporting labels → muted hints → faint chrome; terminal output has its own readable roles. |
| Brand / interactive | `--accent-active` / `--accent-active-hover` / `--accent-success` / `--accent-warning` / `--text-on-accent` | Figma active green and warning amber with explicit state intent. |
| Status | `--accent-success`, `--accent-warning`, `--accent-error`, `--accent-error-light`, `--accent-error-deep`, `--modified-yellow` | Semantic states. Error values are retained as reviewed legacy inputs until their Figma mapping is confirmed. |
| Info blue | `--info(-hover/-light/-dark)` | Links, info banners, "open" PR state, focus accents. |
| Purple | `--purple`, `--purple-light`, `--purple-deep-rgb` | AI / agent surfaces only (skills, MCP, plugin marketplace). |
| Slack | `--slack-pink`, `--slack-lavender(-bright)` | Slack community CTA branding only (dashboard, setup, support panel). |
| RGB triplets | `--accent-*-rgb` and feature `--*-rgb` values | For alpha tints only, e.g. `rgba(var(--accent-error-rgb), 0.1)`. Each must stay in sync with its solid token. |
| Tints | `--tint-subtle` / `--tint` / `--tint-strong` | White hover/selection washes on dark surfaces (5/8/10% white). |
| Overlays | `--overlay-30` … `--overlay-80` | Black scrims behind modals, image dimming. Suffix = alpha %. |
| ANSI palette | `--ansi-green/red/yellow/blue(-dark)` (+ `-rgb`) | Terminal-flavored output: health diagnostics, browser tools, log rendering. Not for general UI status — that's the status group. |
| Code syntax | `--code-keyword/string/property/comment` | VS Code dark syntax colors for code mode and diff rendering. |
| Structure / hover | `--border-default/subtle/strong`, `--surface-control-hover`, `--surface-selected` | Figma border hierarchy and standard hover/selected roles for rows, tabs, and bordered cards. Legacy `--border` and `--bg-hover` remain aliases. |
| Spacing | `--space-*` primitives plus `--spacing-xs` … `--spacing-2xl` compatibility scale | Product CSS uses semantic spacing aliases; use the imported `--space-*` values when no meaningful role exists. |
| Radius | `--radius-control`, `--radius-card`, `--radius-4/6/8/12/999` | Controls use 6px, cards 8px, and pills/circles use the 999px/full roles. |
| Z-index tiers | `--z-dropdown` (100) → `--z-preview-fullscreen` (900) → `--z-modal-overlay/-modal` (1000/1001) → `--z-tooltip` (1100) → `--z-notification` (1200) → `--z-app-*` / `--z-toast*` (9999–10010) | Pick the tier, not a number: floating menus < fullscreen preview < modals < tooltips < toasts < global app overlays. (`--z-changelog-sentinel` is the deliberate ceiling.) |
| Layout dims | `--editor-panel-w`, `--preview-toolbar-h`, `--tree-panel-w` | Shared panel dimensions that must agree across files (and with `PANEL_WIDTH` in `VisualEditorPanel.tsx`). |
| Shadows | `--shadow-sm` / `--shadow` / `--shadow-md` / `--shadow-lg` | Elevation: small popovers → dropdowns → modals → fullscreen layers. |
| Transitions | `--transition-fast` (0.1s) / `--transition` (0.15s) / `--transition-slow` (0.3s) | Duration + easing bundled: `transition: background var(--transition)`. |
| Type scale | `--font-size-10/11/12/13/16`, `--font-ui`, `--font-code`, `--font-symbol` | Geist for UI, Geist Mono for code/editor styling, and JetBrains Nerd Font for terminal/symbol glyph coverage. |

Need a value that doesn't exist? Add the token to `:root` in `base.css` first, then use it.

### The three escape hatches

1. **File-local tokens** — intentional one-off colors (brand hues, feature accents) go in a `:root`
   block at the top of that feature's CSS file, prefixed with the feature name
   (e.g. `--github-publish-hover-teal` in `features/github.css`).
2. **`css-ok` tag** — a raw value that genuinely must stay (e.g. backgrounds matching xterm's
   theme) gets a `/* css-ok: reason */` comment on the same line; CI skips tagged lines.
3. **Small local z-index** — within the "content" tier (content-on-content stacking), raw `1`,
   `2`, `5`, `10` are fine. Anything that floats over other UI uses a `--z-*` token.

### Plugin-stable API

`--bg-*`, `--text-*`, `--accent`, `--action`, `--border`, `--warning`, `--success`, `--error`,
`--font-mono`, plus the `toolbar-icon-btn` / `btn-primary` / `btn-secondary` classes, are public
API for plugins. Renaming any of them is a breaking change (see CLAUDE.md "Shared CSS Classes").

## Primitives

All in [src/components/primitives/](../src/components/primitives/), styled in `base.css` under
`/* ===== Primitive: … ===== */` sections. Hooks that pair with them: `useModalState`,
`useInvoke` / `useAsyncState`, `useCopyToClipboard`, `usePolling` (see CLAUDE.md).

### ModalFrame — [ModalFrame.tsx](../src/components/primitives/ModalFrame.tsx)

Overlay + content container + optional header with close button. ESC and click-outside built in.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `isOpen` | `boolean` | — | Renders `null` when false. |
| `onClose` | `() => void` | — | Called on ESC / overlay click / close button. |
| `title` | `ReactNode?` | — | Omit entirely to render headerless. |
| `dismissable` | `boolean` | `true` | `false` disables ESC + overlay dismissal (in-flight destructive ops). |
| `className` | `string?` | — | Appended to the content container for width/tone overrides. |
| `showCloseButton` | `boolean` | `true` | Ignored when no `title`. |
| `ariaLabel` | `string?` | falls back to string `title` | Accessible dialog label. |

```tsx
<ModalFrame isOpen={isOpen} onClose={close} title="Rename project">
  {/* body */}
</ModalFrame>
```

Gotchas:

- **Dismissal requires the press to start on the overlay.** A text-selection drag that begins
  inside the modal and releases outside does not close it — don't "fix" this, it protects
  unsaved input.
- CI checks that every `*Modal.tsx` file imports `ModalFrame` (`check-patterns.sh` rule 5).
- Open/close state: `useModalState()` for local toggles, `useModal('id')` from `ModalContext`
  for app-registered modals.

### Button family — [Button.tsx](../src/components/primitives/Button.tsx)

Every button control uses one visual recipe and token set while retaining the semantics of its
interaction: `Button` for actions, `IconButton` for icon-only actions, `ToggleButton` for boolean
controls, `MenuButton` for dropdown triggers, and `SplitButton` for an action plus adjacent menu.
Use the component matching the behavior instead of flattening different controls into one type.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `variant` | `'default' \| 'primary' \| 'secondary' \| 'danger' \| 'ghost' \| 'warning' \| 'variable'` | `'default'` | Figma neutral solid, primary, outline, ghost, warning, and variable roles plus the destructive variant. |
| `appearance` | `'solid' \| 'outline' \| 'ghost'` | from `variant` | Low-level visual recipe override. |
| `tone` | `'neutral' \| 'primary' \| 'danger' \| 'warning' \| 'variable'` | from `variant` | Semantic colour role. |
| `density` | `'standard' \| 'compact'` | `'standard'` | Component density; preferred over the legacy `size` prop. |
| `size` | `'sm' \| 'md'` | `'md'` | `sm` for dense rows/toolbars. |
| `width` | `'hug' \| 'fill'` | `'hug'` | Hug contents or fill the available container width. |
| `block` | `boolean?` | — | Backwards-compatible alias for `width="fill"`. |
| `leftIcon` / `rightIcon` | `ReactNode?` | — | Rendered beside children with the standard gap. |

```tsx
<Button variant="primary" leftIcon={<PlusIcon size={14} />} onClick={create}>
  Create project
</Button>

<Button width="fill" onClick={openProject}>
  Open project
</Button>
```

Raw `<button>` elements are reserved for controls whose geometry is the interaction itself, such
as canvas handles, timeline points, colour swatches, and tab semantics. Toolbar actions,
icon-only actions, toggles, menu triggers, and split actions use the matching family component.

### Spinner — [Spinner.tsx](../src/components/primitives/Spinner.tsx)

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | sm = 14px (inline / inside buttons), md = 20px, lg = 32px (section loading). |
| `label` | `string` | `'Loading'` | Screen-reader announcement (`role="status"`). |

```tsx
<Spinner size="sm" />
```

Gotcha: the spinning arc uses `currentColor` — tint it by setting `color` on the spinner
(`style={{ color: 'var(--accent)' }}`) or let it inherit; inside a green action button it's
automatically dark. The track stays `var(--border)`.

### Dropdown — [Dropdown.tsx](../src/components/primitives/Dropdown.tsx)

Menu with open/close state, click-outside, ESC, alignment, and optional portal positioning.
Exports `Dropdown`, `DropdownItem`, `DropdownDivider`.

| Prop (Dropdown) | Type | Default | Notes |
| --- | --- | --- | --- |
| `trigger` | `(props: DropdownTriggerProps) => ReactNode` | — | Spread the props onto your button — they wire toggle, anchor ref, and aria state. |
| `align` | `'left' \| 'right'` | `'left'` | Which trigger edge the menu aligns to. |
| `portal` | `boolean` | `false` | Body portal + fixed positioning. **Use when an ancestor has `overflow: hidden`** (terminal panes, editor panels) that would clip the menu; re-anchors on scroll/resize. |
| `menuClassName` | `string?` | — | Width/feature tweaks on the menu. |
| `onOpenChange` | `(open: boolean) => void?` | — | E.g. lazy-load menu data. |

`DropdownItem`: `onSelect` (menu auto-closes after, unless `keepOpen`), `icon` (size 14 is the
house convention), `variant: 'default' | 'danger'`, `active`, `disabled`.

```tsx
<Dropdown align="right" trigger={(p) => <button className="toolbar-icon-btn" {...p}>•••</button>}>
  <DropdownItem icon={<EditIcon size={14} />} onSelect={rename}>Rename</DropdownItem>
  <DropdownDivider />
  <DropdownItem variant="danger" onSelect={remove}>Delete</DropdownItem>
</Dropdown>
```

Gotcha: the trigger click already calls `stopPropagation()` (triggers often sit inside clickable
cards), so don't add your own.

### EmptyState — [EmptyState.tsx](../src/components/primitives/EmptyState.tsx)

Centered icon / title / description / action stack for empty lists and zero-data panels.

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `ReactNode` | Required; the headline. |
| `icon` / `description` / `action` | `ReactNode?` | `action` is typically a `<Button>`. |
| `className` | `string?` | Appended for feature spacing tweaks. |

```tsx
<EmptyState icon={<BranchIcon size={24} />} title="No branches yet" action={<Button>New branch</Button>} />
```

### Skeleton — [Skeleton.tsx](../src/components/primitives/Skeleton.tsx)

Pulsing placeholder while content loads.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `variant` | `'text' \| 'card' \| 'grid'` | `'text'` | text = 12px line, card = 96px block, grid = auto-fill grid of cards. |
| `count` | `number` | `1` | Renders that many siblings (or grid cells). |
| `width` / `height` | `number \| string?` | — | Inline size overrides; ignored by `grid`. |
| `className` / `style` | — | — | Pass-through. |

```tsx
<Skeleton variant="grid" count={6} />
```

Gotcha: the `skeleton-pulse` keyframes live in `base.css` only — keyframe names are global in
CSS, and a feature-file duplicate silently overrides every consumer (this happened; CI now fails
duplicates).

## Enforcement

[`scripts/check-patterns.sh`](../scripts/check-patterns.sh) (run via `pnpm check:patterns`, part of
`pnpm check:all` in CI) is a deliberately simple grep-based gate against pre-refactor patterns.
It **fails** on: raw color literals in `src/styles` (unless the line is a `--token:` definition or
carries a `/* css-ok: reason */` tag), `var()` references to custom properties defined nowhere
(an undefined var invalidates the declaration and the style silently doesn't apply — this shipped
invisible hover states for months), duplicate `@keyframes` names (global namespace, import-order
roulette), new `onToast?:` prop interfaces (use `useOptionalToast`), and `*Modal.tsx` files that
don't import `ModalFrame`. It also prints informational counts for remaining `Result<T, String>`
Rust signatures and raw `navigator.clipboard` calls. `pnpm check:loc`
([check-loc-limits.sh](../scripts/check-loc-limits.sh)) separately caps file sizes. The full list
of in/out patterns is in [CLAUDE.md → Patterns That Are "Out"](../CLAUDE.md#patterns-that-are-out).
