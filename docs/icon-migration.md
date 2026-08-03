# Icon migration

The icon migration is tracked in `src/components/icons/icon-inventory.json`.
Every shared icon has a semantic name, a `status` (`new-design`, `legacy`, or
`not-applicable`), a `kind`, and—when replaced—the exact supplied SVG filename.
Outstanding supplied assets are tracked in
`src/components/icons/supplied-asset-review.json`; this keeps reserved/future
assets separate from icons that still need a product decision. Raw inline SVGs
are tracked in `src/components/icons/inline-svg-review.json` with a disposition
of `intentional-graphic` or `reserved`.

Run `pnpm icons:status` for current totals, legacy usage counts, inline review
dispositions, and supplied assets that are not mapped to app functionality. Run
`pnpm icons:check` to verify that every shared export is inventoried, every
mapped source exists, every raw inline SVG has a review disposition, and no file
has introduced additional raw inline SVGs.

## Visual audit

Append one of these parameters while running the app:

- `?iconAudit=legacy` — outline shared legacy icons in red.
- `?iconAudit=new-design` — outline new-design icons in green.
- `?iconAudit=untracked` — outline raw or untracked SVGs in amber.
- `?iconAudit=all` — show all three categories.
- `?iconGallery=1` — open the scrollable gallery of every tracked definition,
  with provenance and source filename.

The audit attributes remain available in the DOM in production, but the visual
outlines are opt-in.

## Size and stroke policy

Standard shared UI icons render at 16px. Compact actions (such as copy,
duplicate, reset, branch, pull request, external link, and the dropdown
chevron) render at 14px. Requests using the previous 14px or 12px values are
resolved to those new sizes at the shared icon boundary. Stroked shared icons
use a 1px SVG stroke width; brand and filled system graphics keep their own
geometry.

## Replacing an icon

1. Copy the source SVG into `src/components/icons/assets/new-design`.
2. Add it to `new-design.tsx`; fixed `#979797` strokes are normalized to
   `currentColor` by the renderer.
3. Keep the existing semantic component name and delegate its implementation to
   `NewDesignIcon`.
4. Change its inventory status from `legacy` to `new-design` and record the
   source filename.
5. Run `pnpm icons:status` and `pnpm icons:check`.

Raw inline SVGs are an explicit migration backlog. Move genuine UI icons into
the shared library. Mark illustrations, graphs, loaders, and other intentional
graphics with provenance before reducing or updating the baseline.
