/**
 * Visual editor controller — owns edit-mode state and the postMessage bridge
 * to the in-iframe selection script (`SELECT_SCRIPT` in
 * `src-tauri/src/proxy/mod.rs`).
 *
 * Lifecycle: toggle on → post `ss:activate` (re-posted on every iframe `load`,
 * since the script re-initializes inert on each HMR reload) → an `ss:select`
 * click resolves to source via the backend (class resolution, plus a parallel
 * image resolution guarded by a staleness token) → edits (`applyToken`,
 * `setBoxSide`, `setPositionSide`, `stepSpacing`, `reset`) twMerge the live class
 * and post `ss:mutate` with breakpoint-scoped preview rules (instant DOM feedback, no
 * write) → `commit` writes the merged className back to source and advances
 * the drift baseline so consecutive edits keep working. Image edits
 * (`replaceImage`) write immediately on confirm. Inline TEXT editing lives in
 * the shared `useTextEditing` hook (mounted alongside this one in Preview.tsx).
 *
 * Exposes `editMode`, `selection`, `currentClass`, image resolution,
 * `multiTarget`, auto-save, and the edit/commit callbacks — consumed by
 * Preview.tsx, which threads them into VisualEditorPanel.
 *
 * Boundaries: lib/edit wrappers (`resolveClassnameSource`, `applyClassnameEdit
 * [Multi]`, `resolveImageSource`/`applySrcEdit`, `findComponentUsage`) over the
 * Rust edit backend; the iframe `ss:*` message protocol; localStorage for the
 * auto-save opt-in.
 *
 * Gotchas: incoming messages are trusted only when `e.source` is the preview
 * iframe's contentWindow — the iframe hosts untrusted project content, and a
 * forged `ss:mutate` would otherwise drive edits on the user's behalf. Every
 * write arms `ss:suppressReload` BEFORE touching disk: Astro's full reload can
 * beat the post-write `ss:commit`, briefly reverting the preview. Live values
 * (`currentClass`, image target) are mirrored into refs so the commit
 * callbacks read fresh state without re-subscribing the message handler.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { twMerge } from 'tailwind-merge';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  applyClassnameEditMulti,
  insertClassAttr,
  resolveImageSource,
  applySrcEdit,
  findComponentUsage,
  spacingValue,
  spacingTokenFor,
  spacingCss,
  stepSpacingValue,
  boxSide,
  boxSidePrefix,
  boxSideUtilityResetSpec,
  positionSide,
  positionSidePrefix,
  positionSideUtilityResetSpec,
  withVariant,
  tokensForVariant,
  removeAtLayer,
  breakpointPrefixes,
  competesWithUnlayered,
  markImportant,
  radiusResetSpec,
  enumResetSpec,
  ENUM_CONTROLS,
  utilityTokenFor,
  SPACING_CONTROLS,
  type SpacingKind,
  type BoxType,
  type Side,
  type Breakpoint,
  type SpacingValue,
  type ResetSpec,
  type ElementSignature,
  type Resolution,
  type ImageResolution,
  type UsageReport,
} from '../lib/edit';
import {
  detectTailwindSetup,
  listCustomClasses,
  createCustomClass,
  updateCustomClass,
  classifyApplyTokens,
  type CustomClass,
  type TailwindSetup,
  type TailwindVersion,
} from '../lib/customClasses';
import { logger } from '../lib/logger';
import { isExpectedStructuralRefusal } from './useElementStructure';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';
import {
  sourceRefFromResolution,
  validateFocusedSourceTarget,
  type ComponentFocusContext,
} from '../lib/components/focus';
import type { SourceRef } from '../lib/components/types';
import {
  isLegacyEditableSurfaceTarget,
  isNegotiatedEditableSurfaceTarget,
  type EditableSurfaceTarget,
} from '../lib/components/editable-surface';
import {
  boundInspectionMessage,
  createInspectionTransport,
  type InspectionSurfaceTransport,
} from '../lib/components/inspection-transport';

/**
 * What the style controls currently edit:
 * - `element` — the selected element's own className (writes to the JSX), the
 *   long-standing behavior.
 * - `class` — a shared custom class's `@apply` list (writes to the entry CSS,
 *   updating every element that carries the class). `baseline` is the saved
 *   token string, for dirty-detection / auto-save.
 */
export type EditTarget = { kind: 'element' } | { kind: 'class'; name: string; baseline: string };

/** The resolutions that have a class literal to write over (`no_class` /
 *  `read_only` elements are never written to). */
type WritableResolution = Extract<Resolution, { status: 'resolved' | 'multi' }>;

/** How many source spots a writable resolution covers (1 for a single location). */
function locationCount(res: WritableResolution): number {
  return res.status === 'multi' ? res.locations.length : 1;
}

function focusedTargetError(
  contextRef: React.RefObject<ComponentFocusContext | null> | undefined,
  resolution: Resolution | null
): {
  context: ComponentFocusContext;
  source: NonNullable<ReturnType<typeof sourceRefFromResolution>>;
} | null {
  const context = contextRef?.current;
  if (!context) return null;
  // A missing resolver range is a refusal, never evidence that the focused
  // definition itself is the target. Do not invoke the guard with null.
  const source = sourceRefFromResolution(resolution);
  if (!source) {
    throw new Error(
      'The focused component source target is no longer valid. Refresh and re-enter focus.'
    );
  }
  const validation = validateFocusedSourceTarget(context, source);
  if (validation.status === 'refused' || !validation.source) {
    throw new Error(
      validation.diagnostic?.message ??
        'The focused component source target is no longer valid. Refresh and re-enter focus.'
    );
  }
  return { context, source: validation.source };
}

function focusedEditBlocked(
  contextRef: React.RefObject<ComponentFocusContext | null> | undefined,
  onToast?: (message: string, type?: 'success' | 'error' | 'info') => void
): boolean {
  if (!contextRef?.current) return false;
  onToast?.(
    'Component focus is active. Select a child with an exact source range before editing.',
    'error'
  );
  return true;
}

/** A breakpoint-scoped slice of the live-preview stylesheet: `decls` applied at
 *  `minPx` and up (0 = base, all widths). A null value deletes that property from
 *  the preview (Reset). Mirrors `select_script.html`'s contract. */
interface PreviewRule {
  minPx: number;
  decls: Record<string, string | null>;
}

/** Persisted opt-in for auto-save (off by default). */
const AUTOSAVE_KEY = 'ss:visualEditor:autoSave';
/** Quiet period after the last edit before an auto-save fires — long enough that a
 *  drag (many rapid mutations) saves once when it settles, not on every frame. */
const AUTOSAVE_DEBOUNCE_MS = 700;

const POSITION_CONTROL = ENUM_CONTROLS.find((control) => control.label === 'Position')!;

/** Index just past the `)` that closes the group opened before `from`, or -1 when
 * the text is malformed/truncated. Quote- and nesting-aware. */
function closingParenIndex(text: string, from: number): number {
  let depth = 1;
  let quote = '';
  for (let i = from; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Replace a deleted custom property inside Tailwind arbitrary-value classes.
 * Tailwind uses underscores to encode spaces inside an arbitrary value, so
 * `hsl(0, 0%, 0%)` must become `hsl(0,_0%,_0%)` in the class string.
 *
 * A reference can be nested inside another reference's fallback
 * (`var(--a,var(--b,red))`), so a kept `var()` still has its fallback rewritten —
 * otherwise deleting `--b` would leave a dangling reference behind. */
function replaceCssVariableInClass(className: string, variableName: string, value: string) {
  const replacement = value.trim().replace(/\s+/g, '_');
  let changed = false;

  const rewrite = (text: string): string => {
    const lower = text.toLowerCase();
    let cursor = 0;
    let output = '';

    while (cursor < text.length) {
      const start = lower.indexOf('var(', cursor);
      if (start === -1) {
        output += text.slice(cursor);
        break;
      }

      const end = closingParenIndex(text, start + 4);
      // Leave malformed/incomplete class text untouched.
      if (end === -1) {
        output += text.slice(cursor);
        break;
      }

      const body = text.slice(start + 4, end - 1);
      const comma = body.indexOf(',');
      const referencedName = (comma === -1 ? body : body.slice(0, comma)).trim();
      output += text.slice(cursor, start);
      if (referencedName === variableName) {
        output += replacement;
        changed = true;
      } else if (comma === -1) {
        output += text.slice(start, end);
      } else {
        output += `var(${body.slice(0, comma + 1)}${rewrite(body.slice(comma + 1))})`;
      }
      cursor = end;
    }

    return output;
  };

  const next = rewrite(className);
  return changed ? next : className;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Optional negotiated target for a framework-hosted component frame. */
  surfaceTarget?: EditableSurfaceTarget | null;
  projectPath: string;
  /** Feature availability (e.g. Next.js project + server ready). */
  enabled: boolean;
  /** Optional workspace-owned edit-mode state shared with another surface. */
  editMode?: boolean;
  /** Receives edit-mode changes when `editMode` is controlled. */
  onEditModeChange?: (enabled: boolean) => void;
  /** Enables selection/data inspection without granting editor write mode. */
  inspectionEnabled?: boolean;
  /** Component-frame writes stay disabled until the owning inspector confirms. */
  writeEnabled?: boolean;
  /** The breakpoint layer edits target (Base = unprefixed). Drives the variant
   *  prefix on written tokens and the min-width of the live-preview rule. */
  activeBreakpoint: Breakpoint;
  /** All breakpoints (incl. Base) — used to recognize/strip variant prefixes. */
  breakpoints: Breakpoint[];
  onToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Revision-bound component definition context, when focus is active. */
  componentFocusRef?: React.RefObject<ComponentFocusContext | null>;
  /** Index-backed UsageScope data; null keeps the legacy backend fallback alive. */
  getIndexedUsage?: (resolution: Resolution) => UsageReport | null;
  /** Optional revision-bound guard used by framework-hosted component frames. */
  sourceEditGuard?: (
    source: SourceRef | null
  ) => { status: 'valid'; source?: SourceRef } | { status: 'refused'; reason: string };
}

export type SourceEditGuard = NonNullable<Params['sourceEditGuard']>;

export interface Selection {
  signature: ElementSignature;
  /** null while the backend resolve is in flight. */
  resolution: Resolution | null;
  /** How many elements on the page share these exact classes (same source ⇒ a
   *  save updates all of them). 1 for a unique element. */
  instanceCount: number;
}

export function useVisualEditor({
  iframeRef,
  surfaceTarget,
  projectPath,
  enabled,
  editMode: controlledEditMode,
  onEditModeChange,
  inspectionEnabled,
  writeEnabled = true,
  activeBreakpoint,
  breakpoints,
  onToast,
  componentFocusRef,
  getIndexedUsage,
  sourceEditGuard,
}: Params) {
  // User intent; the *effective* mode below also requires the feature be enabled,
  // so it flips off automatically when the server restarts (no reset effect).
  const [internalEditModeOn, setInternalEditModeOn] = useState(false);
  const editModeOn = controlledEditMode ?? internalEditModeOn;
  const editMode = enabled && editModeOn;
  const transport = useMemo<InspectionSurfaceTransport>(
    () => createInspectionTransport({ iframeRef, surfaceTarget }),
    [iframeRef, surfaceTarget]
  );
  const inspectionActive = (inspectionEnabled ?? enabled) && transport.active;
  const negotiatedSurface = !!surfaceTarget && isNegotiatedEditableSurfaceTarget(surfaceTarget);
  const legacySurface =
    surfaceTarget === undefined ||
    (!!surfaceTarget && isLegacyEditableSurfaceTarget(surfaceTarget));
  const mutationsEnabled = legacySurface
    ? writeEnabled !== false
    : negotiatedSurface
      ? writeEnabled === true && surfaceTarget?.capabilities.editing === true
      : false;
  // A negotiated frame's identity is an async-operation boundary. Resolver
  // results from a previous frame/session must never be allowed to repopulate
  // the current inspector after a target switch.
  const surfaceRevision = transport.revisionKey;
  const surfaceRevisionRef = useRef(surfaceRevision);
  surfaceRevisionRef.current = surfaceRevision;

  // ── Analytics: edit-mode session tracking ────────────────────────────────
  // Mirror edit-mode intent into a ref so `toggleEditMode` reads the current
  // direction without going stale, plus per-session timing and a saved-edit
  // counter that's reported when the session ends (`visual_edit_stopped`).
  const editModeOnRef = useRef(editModeOn);
  useEffect(() => {
    editModeOnRef.current = editModeOn;
  }, [editModeOn]);
  const editStartedAtRef = useRef<number | null>(null);
  const editsCommittedRef = useRef(0);
  /** Record an edit that persisted to source — one `visual_edit_saved` with the
   *  kind of edit — and count it toward the current edit-mode session. Project
   *  context is auto-attached by `trackEvent`/`enrichProperties`. */
  const recordCommit = useCallback((kind: string, props?: Record<string, unknown>) => {
    editsCommittedRef.current += 1;
    void trackEvent('visual_edit_saved', { kind, mode: 'tailwind', ...props });
  }, []);

  // Known breakpoint prefixes, for scoping a class string to one variant layer.
  const known = useMemo(() => breakpointPrefixes(breakpoints), [breakpoints]);

  // Auto-save: when on, edits persist to source automatically (debounced). Off by
  // default; the choice is remembered across sessions.
  const [autoSave, setAutoSave] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleAutoSave = useCallback(() => {
    setAutoSave((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTOSAVE_KEY, next ? '1' : '0');
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  }, []);

  const [selection, setSelection] = useState<Selection | null>(null);
  // Where the selected element's component is used project-wide (scope hint).
  // Best-effort, fetched after a single-location resolve. Token guards staleness.
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const usageTokenRef = useRef(0);
  /** The class string currently applied live in the iframe (merge baseline). */
  const [currentClass, setCurrentClass] = useState('');
  // Mirror into a ref so `applyToken`/`commit` callbacks read the latest value
  // without re-subscribing. Written only through `setLiveClass` (never in render).
  const currentClassRef = useRef('');
  const setLiveClass = useCallback((value: string) => {
    currentClassRef.current = value;
    setCurrentClass(value);
  }, []);

  // CSS properties the selected element gets from unlayered custom CSS (which beats
  // Tailwind utilities). Edits touching these get the important modifier so the saved
  // class wins the cascade — matching what the !important live preview already shows.
  const unlayeredPropsRef = useRef<string[] | undefined>(undefined);
  useEffect(() => {
    unlayeredPropsRef.current = selection?.signature.unlayeredProps;
  }, [selection]);

  // For a 'multi' resolution (one class string at several source spots): which to
  // write — 'all' (default) or a single location index. Reset on each new selection.
  const [multiTarget, setMultiTargetState] = useState<'all' | number>('all');
  const multiTargetRef = useRef<'all' | number>('all');
  const setMultiTarget = useCallback((t: 'all' | number) => {
    multiTargetRef.current = t;
    setMultiTargetState(t);
  }, []);

  // Inline text editing lives in the shared `useTextEditing` hook (mounted once in
  // Preview.tsx, active for either styling editor) — it owns the ss:textInfo gating
  // and ss:textCommit write-back. This hook keeps only the class/image concerns.

  // The signature of the current selection, mirrored so the class commit/structural
  // gestures read the live source-className baseline without re-subscribing.
  const selectedSigRef = useRef<ElementSignature | null>(null);

  // Image src editing: the resolved src target for the current selection (null when
  // the element isn't an image or its src isn't a static literal). Mirrored into a
  // ref so `replaceImage` reads the latest baseline without re-subscribing.
  const [imageResolution, setImageResolution] = useState<ImageResolution | null>(null);
  const imageTargetRef = useRef<{
    file: string;
    line: number;
    column: number;
    src: string;
  } | null>(null);
  const setImageTarget = useCallback((res: ImageResolution | null) => {
    imageTargetRef.current =
      res?.status === 'resolved'
        ? { file: res.file, line: res.line, column: res.column, src: res.src }
        : null;
    setImageResolution(res);
  }, []);

  // What the controls edit (the element vs. a shared class). Mirrored into a ref
  // so the mutate/commit callbacks branch on the latest value without re-subscribing.
  const [editTarget, setEditTargetState] = useState<EditTarget>({ kind: 'element' });
  const editTargetRef = useRef<EditTarget>({ kind: 'element' });
  const setEditTarget = useCallback((t: EditTarget) => {
    editTargetRef.current = t;
    setEditTargetState(t);
  }, []);

  // A negotiated surface identity is an async-operation boundary. Clear the
  // old selection and source baselines before the replacement frame can report
  // anything; delayed resolver results are rejected by the token checks below.
  useEffect(() => {
    usageTokenRef.current += 1;
    selectedSigRef.current = null;
    setSelection(null);
    setUsage(null);
    setLiveClass('');
    setImageTarget(null);
    setEditTarget({ kind: 'element' });
    setMultiTarget('all');
  }, [surfaceRevision, setEditTarget, setImageTarget, setLiveClass, setMultiTarget]);

  // The project's custom classes (refreshed on edit-mode entry and after writes).
  const [customClasses, setCustomClasses] = useState<CustomClass[]>([]);

  const post = useCallback((msg: unknown) => transport.post(msg), [transport]);

  /**
   * A component-frame preview is still a mutation of untrusted renderer DOM.
   * Re-resolve the selected child at the moment of every preview mutation and
   * require the caller's definition guard to accept that fresh range. The
   * selection and negotiated surface are both captured so a late resolver
   * result cannot mutate a replacement frame or a newly selected child.
   */
  const proveNegotiatedMutationTarget = useCallback(async (): Promise<void> => {
    if (!negotiatedSurface) return;
    if (!mutationsEnabled) {
      throw new Error('Component editing is not confirmed. Confirm Edit main before changing it.');
    }
    if (!sourceEditGuard) {
      throw new Error(
        'The component source boundary is unavailable. Refresh the frame before editing it.'
      );
    }
    const signature = selectedSigRef.current;
    if (!signature) throw new Error('Select an element before changing its component styles.');
    const selectionToken = usageTokenRef.current;
    const revision = surfaceRevisionRef.current;
    const resolution = await resolveClassnameSource(projectPath, signature);
    if (
      usageTokenRef.current !== selectionToken ||
      surfaceRevisionRef.current !== revision ||
      selectedSigRef.current !== signature
    ) {
      throw new Error('The renderer selection changed. Reselect the element and try again.');
    }
    const source = sourceRefFromResolution(resolution);
    if (!source) {
      throw new Error(
        'The selected component child has no exact source range. Refresh and reselect it.'
      );
    }
    const guarded = sourceEditGuard(source);
    if (guarded.status === 'refused') throw new Error(guarded.reason);
    if (!guarded.source) {
      throw new Error(
        'The selected component child has no exact source range. Refresh and reselect it.'
      );
    }
  }, [mutationsEnabled, negotiatedSurface, projectPath, sourceEditGuard]);

  // Route a live-preview mutation by edit target: an element edit sets the
  // selected element's class attribute; a class edit injects decls scoped to the
  // class selector (every instance), leaving element markup untouched.
  const postMutate = useCallback(
    (merged: string, rules: PreviewRule[]): boolean | Promise<boolean> => {
      if (!mutationsEnabled) return false;
      const send = () => {
        const target = editTargetRef.current;
        if (target.kind === 'class') {
          post({ type: 'ss:mutateClass', selector: `.${target.name}`, rules });
        } else {
          post({ type: 'ss:mutate', className: merged, rules });
        }
        return true;
      };
      if (!negotiatedSurface) return send();
      return proveNegotiatedMutationTarget()
        .then(send)
        .catch((error) => {
          onToast?.(formatCommandError(asCommandError(error)), 'error');
          return false;
        });
    },
    [mutationsEnabled, negotiatedSurface, onToast, post, proveNegotiatedMutationTarget]
  );

  /** Apply local live-editor state only after a negotiated preview is proven. */
  const applyLiveMutation = useCallback(
    (merged: string, rules: PreviewRule[], apply: () => void): boolean | Promise<boolean> => {
      const result = postMutate(merged, rules);
      if (result instanceof Promise) {
        return result.then((ok) => {
          if (ok) apply();
          return ok;
        });
      }
      apply();
      return result;
    },
    [postMutate]
  );

  /** Reconcile a variable deletion that already rewrote source. The backend
   * updates saved classes, but the selected element/custom class can still be
   * held in the live editor state until the preview reloads. */
  const reconcileDeletedVariable = useCallback(
    (name: string, value: string) => {
      if (!mutationsEnabled) return;
      const next = replaceCssVariableInClass(currentClassRef.current, name, value);
      if (next === currentClassRef.current) return;

      setLiveClass(next);
      const target = editTargetRef.current;
      if (target.kind === 'class') {
        // The backend has already persisted the rewritten @apply list. Advance
        // this baseline too, otherwise a later Save would write the old var().
        setEditTarget({ ...target, baseline: next.trim() });
      } else {
        const currentSignature = selectedSigRef.current;
        if (currentSignature) {
          const nextSignature = { ...currentSignature, className: next };
          selectedSigRef.current = nextSignature;
          setSelection((prev) => {
            if (!prev) return prev;
            const resolution =
              prev.resolution?.status === 'resolved' || prev.resolution?.status === 'multi'
                ? { ...prev.resolution, class_name: next }
                : prev.resolution;
            return { ...prev, signature: nextSignature, resolution };
          });
        }
      }

      // Apply the rewritten class immediately while the dev server/HMR catches
      // up with the source change. No preview declaration is needed: the new
      // arbitrary-value class is now the canonical live class.
      postMutate(next, []);
      post({ type: 'ss:commit' });
    },
    [mutationsEnabled, post, postMutate, setEditTarget, setLiveClass]
  );

  // Point the controls at the selected element's own className (the default).
  const editElement = useCallback(() => {
    setEditTarget({ kind: 'element' });
    setLiveClass(selectedSigRef.current?.className ?? '');
    post({ type: 'ss:clearClassPreview' });
  }, [post, setEditTarget, setLiveClass]);

  // Point the controls at a custom class: seed the live token bag from its
  // `@apply` list so every control reflects the class's current styles.
  const editClass = useCallback(
    (name: string, tokens: string[]) => {
      if (negotiatedSurface) {
        onToast?.(
          'Shared class editing is unavailable in a component frame. Select the element itself.',
          'info'
        );
        return;
      }
      if (focusedEditBlocked(componentFocusRef, onToast)) return;
      const joined = tokens.join(' ');
      setEditTarget({ kind: 'class', name, baseline: joined });
      setLiveClass(joined);
      post({ type: 'ss:clearClassPreview' });
    },
    [componentFocusRef, negotiatedSurface, onToast, post, setEditTarget, setLiveClass]
  );

  // Activate/deactivate the in-iframe selection layer (external-system sync), and
  // keep it active across HMR reloads (each reload resets the script to inert).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (inspectionActive) {
      post({ type: 'ss:activate' });
      const reactivate = () => post({ type: 'ss:activate' });
      iframe?.addEventListener('load', reactivate);
      return () => iframe?.removeEventListener('load', reactivate);
    }
    post({ type: 'ss:deactivate' });
  }, [inspectionActive, post, iframeRef]);

  const selectElement = useCallback(
    (sig: ElementSignature, instanceCount = 1) => {
      selectedSigRef.current = sig;
      setSelection({ signature: sig, resolution: null, instanceCount });
      setLiveClass(sig.className);
      // A fresh element selection always edits the element (not a leftover class).
      setEditTarget({ kind: 'element' });
      post({ type: 'ss:clearClassPreview' });
      setMultiTarget('all'); // a fresh selection defaults to editing all occurrences
      setUsage(null);
      setImageTarget(null);
      const usageToken = ++usageTokenRef.current;
      const selectionRevision = surfaceRevisionRef.current;
      void (async () => {
        try {
          const resolution = await resolveClassnameSource(projectPath, sig);
          if (
            usageTokenRef.current !== usageToken ||
            surfaceRevisionRef.current !== selectionRevision
          )
            return;
          setSelection({ signature: sig, resolution, instanceCount });
          // Prefer the immutable component index for scope. The old command stays
          // as a rollout fallback for projects/targets outside that index.
          const indexedUsage = getIndexedUsage?.(resolution);
          if (indexedUsage) {
            if (
              usageTokenRef.current === usageToken &&
              surfaceRevisionRef.current === selectionRevision
            )
              setUsage(indexedUsage);
          } else if (resolution.status === 'resolved') {
            try {
              const report = await findComponentUsage(
                projectPath,
                resolution.file,
                resolution.line
              );
              if (
                usageTokenRef.current === usageToken &&
                surfaceRevisionRef.current === selectionRevision
              )
                setUsage(report);
            } catch {
              /* scope hint is optional */
            }
          }
        } catch (err) {
          if (
            usageTokenRef.current !== usageToken ||
            surfaceRevisionRef.current !== selectionRevision
          )
            return;
          logger.error('[VisualEditor] resolve failed', {
            error: formatCommandError(asCommandError(err)),
          });
          onToast?.(formatCommandError(asCommandError(err)), 'error');
          setSelection({
            signature: sig,
            resolution: {
              status: 'read_only',
              reason: 'Could not resolve this element to source.',
            },
            instanceCount,
          });
        }
      })();
      // Image src resolution runs in parallel for <img> elements — drives the
      // panel's Image section (current asset + Replace).
      if (sig.tagName === 'img') {
        void (async () => {
          try {
            const imgRes = await resolveImageSource(projectPath, sig);
            // Ignore if the selection changed underneath us.
            if (
              usageTokenRef.current === usageToken &&
              surfaceRevisionRef.current === selectionRevision
            )
              setImageTarget(imgRes);
          } catch (err) {
            if (
              usageTokenRef.current !== usageToken ||
              surfaceRevisionRef.current !== selectionRevision
            )
              return;
            logger.error('[VisualEditor] image resolve failed', {
              error: formatCommandError(asCommandError(err)),
            });
            if (
              usageTokenRef.current === usageToken &&
              surfaceRevisionRef.current === selectionRevision
            )
              setImageTarget({
                status: 'read_only',
                reason: 'Could not resolve this image to source.',
              });
          }
        })();
      }
    },
    [
      getIndexedUsage,
      onToast,
      post,
      projectPath,
      setEditTarget,
      setImageTarget,
      setLiveClass,
      setMultiTarget,
    ]
  );

  // Resolve clicked elements + handle inline text-edit commits from the iframe.
  useEffect(() => {
    if (!inspectionActive) return;
    const handler = (e: MessageEvent) => {
      // SECURITY: only trust messages from the actual preview iframe. The iframe
      // hosts untrusted project content; a forged `ss:textCommit` from another
      // frame would otherwise write to the user's source files.
      if (!transport.accepts(e)) return;
      const d = boundInspectionMessage(e.data);
      if (!d || d.type !== 'ss:select' || !d.signature) return;
      selectElement(d.signature, d.count ?? 1);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [inspectionActive, selectElement, transport]);

  // Load the project's custom classes when edit mode opens; refresh helper lets
  // writes (create/update/delete) push the fresh list back.
  const refreshCustomClasses = useCallback(async () => {
    try {
      setCustomClasses(await listCustomClasses(projectPath));
    } catch (err) {
      logger.error('[VisualEditor] list custom classes failed', {
        error: formatCommandError(asCommandError(err)),
      });
    }
  }, [projectPath]);

  // Whether the project has a writable Tailwind entry stylesheet — gates the
  // "create / edit class" affordances. Apply/edit of existing classes already
  // degrades naturally (the class list is empty without an entry), but create
  // must be disabled with a hint rather than failing on a raw backend error.
  const [classEntryReady, setClassEntryReady] = useState(true);
  // Tailwind grammar context is loaded alongside the custom-class list. Keep a
  // ref for mutation callbacks (which intentionally do not resubscribe to the
  // message bridge) and state for the panel's layer readers.
  const [tailwindSetup, setTailwindSetup] = useState<TailwindSetup | null>(null);
  const tailwindSetupRef = useRef<TailwindSetup | null>(null);

  useEffect(() => {
    if (!inspectionActive) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load custom classes + entry-CSS check on edit-mode open
    void refreshCustomClasses();
    void detectTailwindSetup(projectPath)
      .then((setup) => {
        tailwindSetupRef.current = setup;
        setTailwindSetup(setup);
        setClassEntryReady(setup.entryCss != null);
      })
      .catch(() => {
        tailwindSetupRef.current = null;
        setTailwindSetup(null);
        setClassEntryReady(false);
      });
  }, [inspectionActive, projectPath, refreshCustomClasses]);

  /**
   * Merge a Tailwind token into the live class at the active breakpoint and
   * preview it (no write). `token` is the BARE (unprefixed) utility — we add the
   * active breakpoint's variant prefix here, so callers stay breakpoint-agnostic.
   *
   * `style` is the CSS the token resolves to, sent as a breakpoint-scoped preview
   * rule. It exists because Tailwind's JIT only emits CSS for classes found in
   * source — a freshly-typed `md:p-14` has no compiled rule, so the class alone
   * shows nothing until saved. The rule (at the breakpoint's min-width) drives a
   * truthful preview: a `md:` edit only shows ≥768px, unlike an inline style.
   */
  const applyToken = useCallback(
    (token: string, style?: Record<string, string>) => {
      if (!mutationsEnabled) return;
      const setup = tailwindSetupRef.current;
      const version: TailwindVersion = setup?.version ?? 'v4';
      const utilityPrefix = setup?.utilityPrefix ?? undefined;
      const prefixed = utilityTokenFor(token, utilityPrefix);
      const current = style?.position
        ? removeAtLayer(
            currentClassRef.current,
            activeBreakpoint,
            known,
            enumResetSpec(POSITION_CONTROL, utilityPrefix).match
          )
        : style?.['border-radius']
          ? removeAtLayer(
              currentClassRef.current,
              activeBreakpoint,
              known,
              radiusResetSpec(utilityPrefix).match
            )
          : currentClassRef.current;
      // Mark important when the edited property is set by unlayered custom CSS, so
      // the saved utility wins the cascade (the live preview already wins via !important).
      const bare =
        style && competesWithUnlayered(Object.keys(style), unlayeredPropsRef.current)
          ? markImportant(prefixed, version)
          : prefixed;
      const merged = twMerge(current, withVariant(activeBreakpoint.prefix, bare));
      const rules: PreviewRule[] = style ? [{ minPx: activeBreakpoint.minPx, decls: style }] : [];
      return applyLiveMutation(merged, rules, () => setLiveClass(merged));
    },
    [mutationsEnabled, applyLiveMutation, setLiveClass, activeBreakpoint, known]
  );

  /** Set one side of a box (padding/margin) at the active breakpoint to a scale
   *  step or arbitrary value. Previews only the sides this layer actually defines
   *  (so unset sides fall through to the real, already-compiled base CSS). */
  const setBoxSide = useCallback(
    (type: BoxType, side: Side, value: SpacingValue) => {
      if (!mutationsEnabled) return;
      const setup = tailwindSetupRef.current;
      const version: TailwindVersion = setup?.version ?? 'v4';
      const utilityPrefix = setup?.utilityPrefix ?? undefined;
      const spacingScale = setup?.spacingScale ?? undefined;
      const valueOptions = {
        tailwindVersion: version,
        utilityPrefix,
        spacingScale,
        spacingUnit: selectedSigRef.current?.spacingUnit,
      };
      const bare = utilityTokenFor(
        spacingTokenFor(boxSidePrefix(type, side), value, valueOptions),
        utilityPrefix
      );
      const token = competesWithUnlayered([`${type}-${side}`], unlayeredPropsRef.current)
        ? markImportant(bare, version)
        : bare;
      const current = removeAtLayer(
        currentClassRef.current,
        activeBreakpoint,
        known,
        boxSideUtilityResetSpec(type, side, utilityPrefix).match
      );
      const merged = twMerge(current, withVariant(activeBreakpoint.prefix, token));
      const scoped = tokensForVariant(merged, activeBreakpoint.prefix, known);
      const decls: Record<string, string> = {};
      for (const s of ['top', 'right', 'bottom', 'left'] as Side[]) {
        const v = boxSide(scoped, type, s, { ...valueOptions, utilityPrefix });
        if (v) decls[`${type}-${s}`] = spacingCss(v, valueOptions);
      }
      return applyLiveMutation(merged, [{ minPx: activeBreakpoint.minPx, decls }], () =>
        setLiveClass(merged)
      );
    },
    [mutationsEnabled, applyLiveMutation, setLiveClass, activeBreakpoint, known]
  );

  /** Set one position offset at the active breakpoint. Like the spacing box,
   *  preview every effective offset so `inset-*` fallbacks remain visible while
   *  a side-specific utility is being edited. */
  const setPositionSide = useCallback(
    (side: Side, value: SpacingValue) => {
      if (!mutationsEnabled) return;
      const setup = tailwindSetupRef.current;
      const version: TailwindVersion = setup?.version ?? 'v4';
      const utilityPrefix = setup?.utilityPrefix ?? undefined;
      const spacingScale = setup?.spacingScale ?? undefined;
      const valueOptions = {
        tailwindVersion: version,
        utilityPrefix,
        spacingScale,
        spacingUnit: selectedSigRef.current?.spacingUnit,
      };
      const bare = utilityTokenFor(
        spacingTokenFor(positionSidePrefix(side), value, valueOptions),
        utilityPrefix
      );
      const token = competesWithUnlayered([side], unlayeredPropsRef.current)
        ? markImportant(bare, version)
        : bare;
      const current = removeAtLayer(
        currentClassRef.current,
        activeBreakpoint,
        known,
        positionSideUtilityResetSpec(side, utilityPrefix).match
      );
      const merged = twMerge(current, withVariant(activeBreakpoint.prefix, token));
      const scoped = tokensForVariant(merged, activeBreakpoint.prefix, known);
      const positionOptions = {
        ...valueOptions,
        utilityPrefix,
        direction: selectedSigRef.current?.direction,
        writingMode: selectedSigRef.current?.writingMode,
      };
      const decls: Record<string, string> = {};
      for (const s of ['top', 'right', 'bottom', 'left'] as Side[]) {
        const v = positionSide(scoped, s, positionOptions);
        if (v) decls[s] = spacingCss(v, positionOptions);
      }
      return applyLiveMutation(merged, [{ minPx: activeBreakpoint.minPx, decls }], () =>
        setLiveClass(merged)
      );
    },
    [mutationsEnabled, applyLiveMutation, setLiveClass, activeBreakpoint, known]
  );

  /** Step a spacing utility (padding/margin/gap) by `step` units (default 1) at the
   *  active breakpoint, computed from that layer's current value (so stepping `md:`
   *  reads the md value, not base). Steps the scale integer, or a numeric arbitrary
   *  value's magnitude (keeping its unit). Drives a breakpoint-scoped preview rule. */
  const stepSpacing = useCallback(
    (kind: SpacingKind, dir: 1 | -1, step = 1) => {
      const ctrl = SPACING_CONTROLS.find((c) => c.kind === kind);
      if (!ctrl) return;
      const scoped = tokensForVariant(currentClassRef.current, activeBreakpoint.prefix, known);
      const setup = tailwindSetupRef.current;
      const valueOptions = {
        tailwindVersion: setup?.version ?? 'v4',
        utilityPrefix: setup?.utilityPrefix ?? undefined,
        spacingScale: setup?.spacingScale ?? undefined,
        spacingUnit: selectedSigRef.current?.spacingUnit,
      };
      const next = stepSpacingValue(
        spacingValue(scoped, ctrl.prefix, valueOptions),
        dir * step,
        kind === 'margin'
      );
      return applyToken(spacingTokenFor(ctrl.prefix, next, valueOptions), {
        [ctrl.css]: spacingCss(next, valueOptions),
      });
    },
    [applyToken, activeBreakpoint, known]
  );

  /** Reset a property at the active breakpoint: remove its tokens from that layer
   *  and null out its preview decls so the value reverts to its inherited/default
   *  state. The class change is dirty, so Save (or auto-save) persists the removal. */
  const reset = useCallback(
    (spec: ResetSpec) => {
      if (!mutationsEnabled) return;
      const merged = removeAtLayer(currentClassRef.current, activeBreakpoint, known, spec.match);
      if (merged === currentClassRef.current) return; // nothing to remove
      const decls: Record<string, string | null> = {};
      for (const p of spec.cssProps) decls[p] = null;
      return applyLiveMutation(merged, [{ minPx: activeBreakpoint.minPx, decls }], () =>
        setLiveClass(merged)
      );
    },
    [mutationsEnabled, applyLiveMutation, setLiveClass, activeBreakpoint, known]
  );

  /** Write `next` over `prev` at the element's resolved source location(s).
   *
   *  On an `old_class` drift rejection — the file changed between selection and
   *  save (a formatter, HMR, an agent edit), so the baseline no longer matches —
   *  re-resolve the element against the CURRENT source and re-apply against the
   *  fresh baseline rather than dropping the user's styling. That's the recovery
   *  inline text edits have had since #557, extended to class/style writes
   *  (#739); the guard itself stays intact, since the retry writes against a
   *  just-read baseline and never forces a stale one through. The retry also
   *  refuses to widen the blast radius: if the fresh resolve covers MORE source
   *  spots than the one the user picked against, it fails instead of letting the
   *  default 'all' write to instances the picker never showed.
   *
   *  Returns the resolution the write actually landed on, so callers advance
   *  their drift baseline to where the element really is now. */
  const guardSourceEdit = useCallback(
    (source: SourceRef | null): SourceRef | null => {
      if (surfaceTarget === null) {
        throw new Error('No live renderer surface is selected. Reselect the component frame.');
      }
      if (negotiatedSurface) {
        if (!mutationsEnabled) {
          throw new Error(
            'Component editing is not confirmed. Confirm Edit main before changing it.'
          );
        }
        if (!source) {
          throw new Error(
            'The selected component child has no exact source range. Refresh and reselect it.'
          );
        }
        if (!sourceEditGuard) {
          throw new Error(
            'The component source boundary is unavailable. Refresh the frame before editing it.'
          );
        }
        const guarded = sourceEditGuard(source);
        if (guarded.status === 'refused' || !guarded.source) {
          throw new Error(
            guarded.status === 'refused'
              ? guarded.reason
              : 'The selected component child has no exact source range. Refresh and reselect it.'
          );
        }
        return guarded.source;
      }
      const result = sourceEditGuard?.(source);
      if (result?.status === 'refused') throw new Error(result.reason);
      return result?.status === 'valid' ? (result.source ?? source) : source;
    },
    [mutationsEnabled, negotiatedSurface, sourceEditGuard, surfaceTarget]
  );

  const writeClassToSource = useCallback(
    async (
      sig: ElementSignature,
      res: WritableResolution,
      prev: string,
      next: string
    ): Promise<WritableResolution> => {
      if (!mutationsEnabled) {
        throw new Error(
          'Component editing is not confirmed. Confirm Edit main before changing it.'
        );
      }
      const writeRevision = surfaceRevisionRef.current;
      const writeSelectionToken = usageTokenRef.current;
      const assertWriteRevision = () => {
        if (surfaceRevisionRef.current !== writeRevision) {
          throw new Error('The renderer surface changed. Reselect the element and try again.');
        }
        if (usageTokenRef.current !== writeSelectionToken) {
          throw new Error('The renderer selection changed. Reselect the element and try again.');
        }
      };
      const write = async (r: WritableResolution, oldClass: string) => {
        assertWriteRevision();
        const guardedSource = guardSourceEdit(sourceRefFromResolution(r));
        const focused = focusedTargetError(componentFocusRef, r);
        if (r.status === 'resolved') {
          await applyClassnameEdit(
            projectPath,
            r.file,
            r.line,
            oldClass,
            next,
            focused
              ? {
                  expectedHash: focused.source.contentHash,
                  expectedStart: focused.source.start,
                  expectedEnd: focused.source.end,
                }
              : guardedSource
                ? {
                    expectedHash: guardedSource.contentHash,
                    expectedStart: guardedSource.start,
                    expectedEnd: guardedSource.end,
                  }
                : undefined
          );
          assertWriteRevision();
        } else {
          if (focused) {
            throw new Error(
              'Component focus cannot edit an ambiguous class source. Select the exact child again.'
            );
          }
          // Honor the user's multi-location pick ('all' vs one index).
          const mt = multiTargetRef.current;
          const edits = mt === 'all' ? r.locations : r.locations.filter((_, i) => i === mt);
          await applyClassnameEditMulti(projectPath, edits, oldClass, next);
          assertWriteRevision();
        }
      };
      try {
        // A negotiated frame may have selected a perfectly valid child a few
        // renders ago, but that proof is not authority for a new write. Resolve
        // again immediately before touching source and use its current class
        // baseline, while retaining the same frame/revision guard.
        const currentResolution = negotiatedSurface
          ? await resolveClassnameSource(projectPath, sig)
          : res;
        assertWriteRevision();
        if (currentResolution.status !== 'resolved' && currentResolution.status !== 'multi') {
          throw new Error(
            'The selected component child has no exact source range. Refresh and reselect it.'
          );
        }
        if (negotiatedSurface && currentResolution.status !== 'resolved') {
          throw new Error(
            'The selected component child has no exact source range. Refresh and reselect it.'
          );
        }
        const currentBaseline =
          negotiatedSurface && currentResolution.status === 'resolved'
            ? currentResolution.class_name
            : prev;
        await write(currentResolution, currentBaseline);
        return currentResolution;
      } catch (err) {
        const cmdErr = asCommandError(err);
        if (!(cmdErr.type === 'Validation' && cmdErr.field === 'old_class')) throw err;
        const fresh = await resolveClassnameSource(projectPath, sig);
        assertWriteRevision();
        if (fresh.status !== 'resolved' && fresh.status !== 'multi') throw err;
        // The multi-location pick ('all' by default) was made against the
        // locations resolved at SELECTION time. If the re-resolve now finds MORE
        // of them, the drift added instances the user never saw in the picker —
        // silently writing to all of them (or to a shifted index) would edit
        // markup they never chose. Fail the retry instead and let the caller's
        // revert+toast path run.
        if (locationCount(fresh) > locationCount(res)) {
          throw new Error(
            "Couldn't save — this element now appears in more places in the source than when you selected it. Reselect it and choose which one to edit."
          );
        }
        // Already carrying the class we wanted (someone else's write beat us to
        // the same result) — nothing left to do.
        if (fresh.class_name !== next) await write(fresh, fresh.class_name);
        // Recovered drift is an expected environment state, not a bug.
        logger.warn('[VisualEditor] stale class save recovered by re-resolving', {
          error: formatCommandError(cmdErr),
        });
        return fresh;
      }
    },
    [componentFocusRef, guardSourceEdit, mutationsEnabled, negotiatedSurface, projectPath]
  );

  /** Persist the current live class to source. `silent` suppresses the success
   *  toast (used by auto-save, which shouldn't toast on every debounced write —
   *  errors still surface). */
  const commit = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!mutationsEnabled) return;
      const commitRevision = surfaceRevisionRef.current;
      const assertCommitRevision = () => {
        if (surfaceRevisionRef.current !== commitRevision) {
          throw new Error('The renderer surface changed. Reselect the element and try again.');
        }
      };
      // Class edit: persist the @apply list to the entry CSS (updates every
      // instance). No element markup changes, so the element-baseline dance below
      // doesn't apply. Suppress the reload our own save triggers (avoids a flash).
      const target = editTargetRef.current;
      if (target.kind === 'class') {
        if (negotiatedSurface) {
          onToast?.(
            'Shared class editing is unavailable in a component frame. Select the element itself.',
            'info'
          );
          return;
        }
        if (focusedEditBlocked(componentFocusRef, onToast)) return;
        const next = currentClassRef.current.trim();
        if (next === target.baseline.trim()) return; // unchanged
        const tokens = next.split(/\s+/).filter(Boolean);
        try {
          post({ type: 'ss:suppressReload' });
          const list = await updateCustomClass(projectPath, target.name, tokens);
          assertCommitRevision();
          setCustomClasses(list);
          recordCommit('custom_class', { op: 'edit' });
          // Advance the baseline so consecutive edits (and auto-save) keep working.
          setEditTarget({ kind: 'class', name: target.name, baseline: tokens.join(' ') });
          // Keep the live override as the committed state — do NOT clear it here.
          // The save's HMR reload is suppressed (no flash), so clearing would drop
          // the element back to the STALE compiled rule until the next real reload,
          // making the just-saved edit visibly revert. The override already mirrors
          // the saved tokens; it's reconciled with the freshly-compiled @apply rule
          // when the edit target switches or the panel closes (both clear class
          // previews), or on the next genuine reload. Mirrors how element edits keep
          // their live state via ss:commit rather than discarding it.
          if (!opts?.silent) onToast?.('Class saved', 'success');
        } catch (err) {
          logger.error('[VisualEditor] class write-back failed', {
            error: formatCommandError(asCommandError(err)),
          });
          onToast?.(formatCommandError(asCommandError(err)), 'error');
        }
        return;
      }

      const sel = selection;
      const res = sel?.resolution;
      if (!res || (res.status !== 'resolved' && res.status !== 'multi')) return;
      const next = currentClassRef.current;
      // Use the LIVE source className (selectedSigRef) as the drift baseline, not
      // the possibly-stale `selection` closure — a structural gesture may have
      // advanced the source since this `commit` callback was created, and writing
      // against a stale old-value would silently no-op at the backend.
      const prev = selectedSigRef.current?.className ?? res.class_name;
      if (next === prev) return; // nothing changed
      try {
        // Prove the selected child before changing renderer state. The source write
        // performs the same fresh proof again, but suppression itself must not be
        // sent when the negotiated selection has already gone stale.
        if (negotiatedSurface) await proveNegotiatedMutationTarget();
        // Arm the reload-suppression window BEFORE writing: Astro's full-reload fires
        // the instant the file changes, which can beat the post-write ss:commit. Setting
        // it here means the reload our own save triggers is reliably swallowed (so the
        // live preview doesn't briefly revert), while agent edits still reload.
        post({ type: 'ss:suppressReload' });
        const landed = await writeClassToSource(sel.signature, res, prev, next);
        assertCommitRevision();
        // Advance the drift baseline so consecutive edits keep working. Keep
        // selectedSigRef in lockstep — the structural gestures use it as the live
        // source-className baseline, so it must reflect saved style edits too.
        setSelection({ ...sel, resolution: { ...landed, class_name: next } });
        if (selectedSigRef.current) {
          selectedSigRef.current = { ...selectedSigRef.current, className: next };
        }
        // Tell the in-iframe script this live state is now the saved baseline, so
        // deactivating (closing the panel) doesn't revert the just-saved edit
        // before HMR re-renders it from source.
        post({ type: 'ss:commit' });
        recordCommit('style');
        if (!opts?.silent) onToast?.('Saved to source', 'success');
      } catch (err) {
        logger.error('[VisualEditor] write-back failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast?.(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [
      componentFocusRef,
      selection,
      projectPath,
      onToast,
      post,
      setEditTarget,
      recordCommit,
      writeClassToSource,
      guardSourceEdit,
      mutationsEnabled,
      negotiatedSurface,
      proveNegotiatedMutationTarget,
    ]
  );

  /** Rewrite the selected element's className in source to `next` (single or
   *  multi location), advancing the drift baseline. Shared by the class apply /
   *  unapply / extract gestures. No-op (returns false) on an unresolved element. */
  const writeElementClass = useCallback(
    async (next: string): Promise<boolean> => {
      if (!mutationsEnabled) return false;
      const sel = selection;
      const res = sel?.resolution;
      if (!res || (res.status !== 'resolved' && res.status !== 'multi')) {
        onToast?.('Select an element whose source can be resolved first.', 'error');
        return false;
      }
      // Drift baseline = the LIVE source className (selectedSigRef), not the
      // possibly-stale `selection` state — so a burst of applies/unapplies before
      // React re-renders each still writes against the right old value.
      const prev = selectedSigRef.current?.className ?? res.class_name;
      if (next === prev) return true;
      if (negotiatedSurface) await proveNegotiatedMutationTarget();
      post({ type: 'ss:suppressReload' });
      const landed = await writeClassToSource(sel.signature, res, prev, next);
      // Keep BOTH the selection signature (drives the class-bar chips) and the
      // resolution baseline (drift guard) in sync with the element's new class.
      const nextSig = { ...sel.signature, className: next };
      setSelection({ ...sel, signature: nextSig, resolution: { ...landed, class_name: next } });
      selectedSigRef.current = nextSig;
      // Reflect on the element itself (in element mode the live class is the element).
      if (editTargetRef.current.kind === 'element') setLiveClass(next);
      post({ type: 'ss:mutate', className: next, rules: [] });
      post({ type: 'ss:commit' });
      return true;
    },
    [
      mutationsEnabled,
      negotiatedSurface,
      onToast,
      post,
      proveNegotiatedMutationTarget,
      selection,
      setLiveClass,
      writeClassToSource,
    ]
  );

  /** Add the FIRST class to a class-less element (a `no_class` resolution): the
   *  element has no class literal in source to resolve or replace, so the backend
   *  INSERTS a fresh class attribute on its open tag (located by ancestor/text
   *  anchoring — it rejects with a specific reason rather than guess). On success,
   *  re-resolve so the panel transitions from the no-class state to full controls. */
  const addFirstClass = useCallback(
    async (name: string) => {
      if (!mutationsEnabled) return;
      if (focusedEditBlocked(componentFocusRef, onToast)) return;
      if (negotiatedSurface) {
        onToast?.(
          'This component child has no exact source range for adding a first class. Reselect it after the renderer refreshes.',
          'info'
        );
        return;
      }
      const sig = selectedSigRef.current;
      const n = name.trim().replace(/^\./, '');
      if (!sig || !n) return;
      // Arm reload suppression before writing (same reasoning as a class commit).
      try {
        post({ type: 'ss:suppressReload' });
        await insertClassAttr(projectPath, sig, n);
        const nextSig = { ...sig, className: n };
        selectedSigRef.current = nextSig;
        setLiveClass(n);
        post({ type: 'ss:mutate', className: n, rules: [] });
        post({ type: 'ss:commit' });
        // The inserted literal is now the element's source anchor — re-resolve so
        // the selection gains a real location and the full controls appear.
        const resolution = await resolveClassnameSource(projectPath, nextSig);
        setSelection((prev) => (prev ? { ...prev, signature: nextSig, resolution } : prev));
        recordCommit('class');
        onToast?.('Class added', 'success');
      } catch (err) {
        const message = formatCommandError(asCommandError(err));
        // The classless-anchor ladder declining to guess among look-alike tags
        // is a by-design refusal (#318/#818) — warn + info, never a bug report
        // (issue #852).
        const refusal = isExpectedStructuralRefusal(message);
        logger[refusal ? 'warn' : 'error']('[VisualEditor] add first class failed', {
          error: message,
        });
        onToast?.(message, refusal ? 'info' : 'error');
      }
    },
    [
      componentFocusRef,
      guardSourceEdit,
      mutationsEnabled,
      negotiatedSurface,
      projectPath,
      post,
      setLiveClass,
      onToast,
      recordCommit,
    ]
  );

  /** The selected element's current className — read from the live class in
   *  element mode, or the (kept-fresh) signature while a class is being edited.
   *  The structural gestures below operate on THIS, never on a class's @apply. */
  const currentElementClass = useCallback(
    () =>
      editTargetRef.current.kind === 'element'
        ? currentClassRef.current
        : (selectedSigRef.current?.className ?? ''),
    []
  );

  /** Append an existing custom class to the selected element. Does NOT switch the
   *  edit target — so several classes can be added in a row without the panel
   *  yanking you into editing each one. */
  const applyClass = useCallback(
    async (name: string) => {
      const current = currentElementClass().split(/\s+/).filter(Boolean);
      if (current.includes(name)) return; // already on the element
      try {
        await writeElementClass([...current, name].join(' '));
        recordCommit('custom_class', { op: 'apply' });
      } catch (err) {
        onToast?.(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [currentElementClass, writeElementClass, onToast, recordCommit]
  );

  /** Remove a custom class from the selected element (the class stays defined in
   *  CSS). Falls back to editing the element only if the removed class was the
   *  active edit target. */
  const unapplyClass = useCallback(
    async (name: string) => {
      const next = currentElementClass()
        .split(/\s+/)
        .filter((t) => t && t !== name)
        .join(' ');
      const wasEditing =
        editTargetRef.current.kind === 'class' && editTargetRef.current.name === name;
      try {
        const ok = await writeElementClass(next);
        if (ok && wasEditing) editElement();
        recordCommit('custom_class', { op: 'unapply' });
      } catch (err) {
        onToast?.(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [currentElementClass, writeElementClass, editElement, onToast, recordCommit]
  );

  /** Webflow-style "create class from styles": move the element's utility tokens
   *  into a new named class, keeping any classes it already had, then replace the
   *  utilities on the element with the bare class name and edit the class. (The
   *  element briefly shows unstyled until HMR compiles the new rule's `@apply`.) */
  const createClassFromStyles = useCallback(
    async (name: string) => {
      if (!mutationsEnabled) return;
      if (negotiatedSurface) {
        onToast?.(
          'Creating shared classes is unavailable in a component frame. Select the element itself.',
          'info'
        );
        return;
      }
      if (focusedEditBlocked(componentFocusRef, onToast)) return;
      const elTokens = currentElementClass().split(/\s+/).filter(Boolean);
      const classNames = new Set(customClasses.map((c) => c.name));
      const candidateUtilities = elTokens.filter((t) => !classNames.has(t));
      try {
        // Tokens that are plain custom classes (not utilities) can't go in @apply —
        // applying them would break the Tailwind build. Keep those on the element.
        const unsafe = new Set(await classifyApplyTokens(projectPath, candidateUtilities));
        const utilities = candidateUtilities.filter((t) => !unsafe.has(t));
        // Element keeps its existing classes + any non-utility tokens we couldn't move.
        const kept = elTokens.filter((t) => classNames.has(t) || unsafe.has(t));
        if (utilities.length === 0) {
          onToast?.('This element has no Tailwind utilities to extract into a class.', 'error');
          return;
        }
        const list = await createCustomClass(projectPath, name, utilities);
        setCustomClasses(list);
        recordCommit('custom_class', { op: 'create' });
        const ok = await writeElementClass([...kept, name].join(' '));
        if (!ok) {
          // The class was created but couldn't be applied — still let the user edit it.
          onToast?.(`Created .${name}, but couldn't update the element.`, 'error');
        }
        editClass(name, utilities);
        if (unsafe.size > 0) {
          onToast?.(`Kept ${[...unsafe].join(', ')} on the element (not a utility).`, 'success');
        }
      } catch (err) {
        onToast?.(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [
      projectPath,
      customClasses,
      currentElementClass,
      writeElementClass,
      editClass,
      componentFocusRef,
      mutationsEnabled,
      negotiatedSurface,
      onToast,
      recordCommit,
    ]
  );

  // NOTE: deleting a custom class (delete_custom_class backend command) is a
  // Phase-2 follow-up — it needs a confirmation flow in the bar since it removes
  // shared styles and leaves orphan class names in markup. Intentionally not
  // wired to UI yet (rather than shipped as a dead, unconfirmed action).

  /**
   * Replace the selected image's src in source (immediate write, like a text
   * commit — picking an asset IS the save) and swap the preview instantly.
   * Throws on failure so the picker can stay open for another try.
   */
  const replaceImage = useCallback(
    async (newSrc: string) => {
      if (!mutationsEnabled) {
        throw new Error(
          'Component editing is not confirmed. Confirm Edit main before changing it.'
        );
      }
      if (focusedEditBlocked(componentFocusRef, onToast)) {
        throw new Error('Component focus requires an exact child source target.');
      }
      const target = imageTargetRef.current;
      if (!target) {
        onToast?.('Lost track of this image — reselect it and try again.', 'error');
        throw new Error('no image target');
      }
      if (newSrc === target.src) return; // already this asset — nothing to write
      const imageRevision = surfaceRevisionRef.current;
      const imageSelectionToken = usageTokenRef.current;
      const imageSignature = selectedSigRef.current;
      const assertImageSelection = () => {
        if (
          usageTokenRef.current !== imageSelectionToken ||
          surfaceRevisionRef.current !== imageRevision ||
          selectedSigRef.current !== imageSignature
        ) {
          throw new Error('The renderer selection changed. Reselect the element and try again.');
        }
      };
      // Arm reload suppression before writing (same reasoning as a class commit).
      try {
        // Image resolution has no range of its own. For a negotiated component
        // frame, freshly resolve the selected child and use that exact proof as
        // the mutation boundary; a null guard would permanently (and correctly)
        // refuse every image write.
        let guardedSource: SourceRef | null = null;
        if (surfaceTarget) {
          const signature = imageSignature;
          if (!signature) throw new Error('Reselect the image before replacing it.');
          const resolution = await resolveClassnameSource(projectPath, signature);
          assertImageSelection();
          guardedSource = guardSourceEdit(sourceRefFromResolution(resolution));
          if (!guardedSource) {
            throw new Error(
              'The selected component child has no exact source range. Refresh and reselect it.'
            );
          }
        }
        assertImageSelection();
        post({ type: 'ss:suppressReload' });
        await applySrcEdit(
          projectPath,
          target.file,
          target.line,
          target.column,
          target.src,
          newSrc
        );
        assertImageSelection();
        // Advance the drift baseline so consecutive replacements keep working.
        target.src = newSrc;
        setImageResolution((prev) =>
          prev?.status === 'resolved' ? { ...prev, src: newSrc } : prev
        );
        post({ type: 'ss:setSrc', value: newSrc }); // instant preview (HMR confirms)
        post({ type: 'ss:commit' });
        recordCommit('image');
        onToast?.('Image replaced', 'success');
      } catch (err) {
        logger.error('[VisualEditor] image write-back failed', {
          error: formatCommandError(asCommandError(err)),
        });
        onToast?.(formatCommandError(asCommandError(err)), 'error');
        throw err;
      }
    },
    [
      componentFocusRef,
      guardSourceEdit,
      mutationsEnabled,
      projectPath,
      onToast,
      post,
      recordCommit,
      surfaceTarget,
    ]
  );

  // Auto-save: debounce a silent commit after edits settle. Re-running on every
  // class change clears the prior timer (so a drag saves once, when it stops); the
  // resolved-and-dirty guard means it never fires on selection alone, and the
  // baseline-advance inside `commit` makes the next run a no-op (no loop).
  useEffect(() => {
    if (!autoSave) return;
    let dirty = false;
    if (editTarget.kind === 'class') {
      dirty = currentClass.trim() !== editTarget.baseline.trim();
    } else {
      const res = selection?.resolution;
      if (res?.status !== 'resolved' && res?.status !== 'multi') return;
      dirty = currentClass !== res.class_name;
    }
    if (!dirty) return;
    const id = window.setTimeout(() => void commit({ silent: true }), AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [autoSave, currentClass, selection, editTarget, commit]);

  const clearEditState = useCallback(() => {
    setSelection(null);
    setLiveClass('');
    setImageTarget(null);
    setEditTarget({ kind: 'element' });
    selectedSigRef.current = null;
  }, [setEditTarget, setImageTarget, setLiveClass]);

  const previousEditModeOnRef = useRef(editModeOn);
  useEffect(() => {
    const previous = previousEditModeOnRef.current;
    previousEditModeOnRef.current = editModeOn;
    if (previous && !editModeOn) clearEditState();
  }, [clearEditState, editModeOn]);

  const toggleEditMode = useCallback(() => {
    // Fire lifecycle analytics from the user's toggle intent (read via ref so the
    // direction is never stale), outside the state updater so it runs exactly once.
    const turningOn = !editModeOnRef.current;
    editModeOnRef.current = turningOn;
    if (turningOn) {
      editStartedAtRef.current = Date.now();
      editsCommittedRef.current = 0;
      void trackEvent('visual_edit_started', { mode: 'tailwind' });
    } else {
      const startedAt = editStartedAtRef.current;
      void trackEvent('visual_edit_stopped', {
        mode: 'tailwind',
        duration_ms: startedAt != null ? Date.now() - startedAt : undefined,
        edits_committed: editsCommittedRef.current,
      });
      editStartedAtRef.current = null;
    }
    if (controlledEditMode !== undefined) onEditModeChange?.(turningOn);
    else setInternalEditModeOn(turningOn);
  }, [controlledEditMode, onEditModeChange]);

  return {
    editMode,
    toggleEditMode,
    /** Select a renderer-proven element without accepting an unvalidated window message. */
    selectElement,
    selection,
    currentClass,
    usage,
    /** Image-src editability of the current selection (drives the Image section). */
    imageResolution,
    /** Write a new src to source and swap the preview (immediate save). */
    replaceImage,
    multiTarget,
    setMultiTarget,
    autoSave,
    toggleAutoSave,
    stepSpacing,
    setBoxSide,
    setPositionSide,
    // Enum controls apply an absolute token (twMerge swaps the prior one) plus an
    // inline-style preview — same path as spacing, just not relative to a scale.
    applyEnum: applyToken,
    reset,
    commit,
    // ── Custom classes (Webflow-style) ───────────────────────────────────────
    /** What the controls currently edit (the element, or a shared class). */
    editTarget,
    /** Switch the controls back to the selected element's own className. */
    editElement,
    /** Switch the controls to a custom class's `@apply` list. */
    editClass,
    /** Keep the live editor in sync after CSS variable deletion rewrites source. */
    reconcileDeletedVariable,
    /** The project's custom classes (for the class bar + apply menu). */
    customClasses,
    /** Whether a writable Tailwind entry stylesheet exists (gates create). */
    classEntryReady,
    /** Tailwind token context used by the visual editor's readers and writers. */
    tailwindVersion: tailwindSetup?.version ?? 'v4',
    utilityPrefix: tailwindSetup?.utilityPrefix,
    spacingScale: tailwindSetup?.spacingScale,
    /** Insert the first class on a class-less element, then re-resolve. */
    addFirstClass,
    /** Append an existing custom class to the element and edit it. */
    applyClass,
    /** Remove a custom class from the element (keeps it defined in CSS). */
    unapplyClass,
    /** Extract the element's utilities into a new named class and edit it. */
    createClassFromStyles,
  };
}
