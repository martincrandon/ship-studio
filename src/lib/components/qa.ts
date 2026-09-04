import { sha256 } from './ranges';
import type { ComponentDescriptor, StaticValue } from './types';
import type { ComponentCanvasFrame } from './canvas';

export const COMPONENT_QA_VERSION = 1 as const;
export const COMPONENT_QA_MAX_MATRIX_CASES = 24;
export const COMPONENT_QA_DEFAULT_PIXEL_THRESHOLD = 0.1;

export interface ComponentQABaseline {
  version: typeof COMPONENT_QA_VERSION;
  frameId: string;
  frameIdentity: string;
  sourceRevision: string;
  screenshotPath: string;
  capturedAt: string;
  pixelThreshold: number;
}

export interface ComponentQABaselineStore {
  version: typeof COMPONENT_QA_VERSION;
  baselines: ComponentQABaseline[];
}

export type ComponentQADiffState =
  | 'unavailable'
  | 'baseline-missing'
  | 'match'
  | 'changed'
  | 'stale';

export interface ComponentQADiff {
  state: ComponentQADiffState;
  threshold: number;
  message: string;
}

export interface ComponentA11yFinding {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  message: string;
  helpUrl?: string;
}

export interface ComponentA11yResult {
  frameId: string;
  sourceRevision: string;
  checkedAt: string;
  findings: ComponentA11yFinding[];
  unavailableReason?: string;
}

export interface ComponentQAMatrixSelection {
  breakpoints: string[];
  locales: string[];
}

export interface ComponentQAMatrixPlan {
  cases: Array<{ breakpoint: string | null; locale: string | null }>;
  refused: boolean;
  message: string | null;
}

export interface ComponentQAAgentPayload {
  prompt: string;
  /** Deliberately excludes source text and absolute paths from analytics. */
  metadata: {
    dialect: ComponentDescriptor['dialect'];
    hasScreenshot: boolean;
    hasA11yFindings: boolean;
    diffState: ComponentQADiffState;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBaseline(value: unknown): value is ComponentQABaseline {
  return (
    isRecord(value) &&
    value.version === COMPONENT_QA_VERSION &&
    typeof value.frameId === 'string' &&
    typeof value.frameIdentity === 'string' &&
    typeof value.sourceRevision === 'string' &&
    typeof value.screenshotPath === 'string' &&
    typeof value.capturedAt === 'string' &&
    typeof value.pixelThreshold === 'number' &&
    Number.isFinite(value.pixelThreshold) &&
    value.pixelThreshold >= 0 &&
    value.pixelThreshold <= 1
  );
}

export function parseComponentQABaselineStore(value: unknown): ComponentQABaselineStore {
  if (
    !isRecord(value) ||
    value.version !== COMPONENT_QA_VERSION ||
    !Array.isArray(value.baselines)
  ) {
    return { version: COMPONENT_QA_VERSION, baselines: [] };
  }
  return {
    version: COMPONENT_QA_VERSION,
    baselines: value.baselines.filter(isBaseline),
  };
}

export function readComponentQABaselineStore(
  storage: Pick<Storage, 'getItem'> | null,
  key: string
): ComponentQABaselineStore {
  if (!storage) return { version: COMPONENT_QA_VERSION, baselines: [] };
  try {
    const raw = storage.getItem(key);
    return raw
      ? parseComponentQABaselineStore(JSON.parse(raw))
      : parseComponentQABaselineStore(null);
  } catch {
    return { version: COMPONENT_QA_VERSION, baselines: [] };
  }
}

export function writeComponentQABaselineStore(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  store: ComponentQABaselineStore
): void {
  storage.setItem(key, JSON.stringify(parseComponentQABaselineStore(store)));
}

export function createComponentQABaseline(
  frame: ComponentCanvasFrame,
  screenshotPath: string,
  sourceRevision: string,
  frameIdentity: string,
  capturedAt = new Date().toISOString(),
  pixelThreshold = COMPONENT_QA_DEFAULT_PIXEL_THRESHOLD
): ComponentQABaseline {
  return {
    version: COMPONENT_QA_VERSION,
    frameId: frame.id,
    frameIdentity,
    sourceRevision,
    screenshotPath,
    capturedAt,
    pixelThreshold: Math.max(0, Math.min(1, pixelThreshold)),
  };
}

export function compareComponentQABaseline(
  baseline: ComponentQABaseline | null,
  input: {
    frameIdentity: string;
    sourceRevision: string;
    currentFingerprint?: string | null;
  }
): ComponentQADiff {
  if (!baseline) {
    return {
      state: 'baseline-missing',
      threshold: COMPONENT_QA_DEFAULT_PIXEL_THRESHOLD,
      message: 'Capture a baseline for this frame.',
    };
  }
  if (
    baseline.sourceRevision !== input.sourceRevision ||
    baseline.frameIdentity !== input.frameIdentity
  ) {
    return {
      state: 'stale',
      threshold: baseline.pixelThreshold,
      message: 'Source or frame settings changed since this baseline was captured.',
    };
  }
  if (!input.currentFingerprint) {
    return {
      state: 'unavailable',
      threshold: baseline.pixelThreshold,
      message: 'A current render fingerprint is unavailable; no diff is claimed.',
    };
  }
  return input.currentFingerprint === baseline.frameIdentity
    ? {
        state: 'match',
        threshold: baseline.pixelThreshold,
        message: 'Current render matches the saved baseline.',
      }
    : {
        state: 'changed',
        threshold: baseline.pixelThreshold,
        message: 'Current render differs from the saved baseline.',
      };
}

export function planComponentQAMatrix(
  selection: ComponentQAMatrixSelection
): ComponentQAMatrixPlan {
  const breakpoints = selection.breakpoints.length > 0 ? selection.breakpoints : [null];
  const locales = selection.locales.length > 0 ? selection.locales : [null];
  const total = breakpoints.length * locales.length;
  if (total > COMPONENT_QA_MAX_MATRIX_CASES) {
    return {
      cases: [],
      refused: true,
      message: `Choose at most ${COMPONENT_QA_MAX_MATRIX_CASES} breakpoint/locale cases at a time.`,
    };
  }
  return {
    cases: breakpoints.flatMap((breakpoint) => locales.map((locale) => ({ breakpoint, locale }))),
    refused: false,
    message: null,
  };
}

export function uncoveredFiniteVariantChoices(
  component: ComponentDescriptor,
  frames: readonly ComponentCanvasFrame[]
): Array<{ prop: string; choice: StaticValue }> {
  const covered = new Set(
    frames.flatMap((frame) =>
      Object.entries(frame.props).map(([name, value]) => `${name}:${JSON.stringify(value)}`)
    )
  );
  return component.props.flatMap(
    (prop) =>
      prop.choices?.flatMap((choice) =>
        covered.has(`${prop.name}:${JSON.stringify(choice)}`) ? [] : [{ prop: prop.name, choice }]
      ) ?? []
  );
}

function displayStaticValue(value: StaticValue): string {
  return JSON.stringify(value);
}

function clampPromptPart(value: string, max: number): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join('')
    .slice(0, max);
}

/** Build an explicit, bounded agent handoff. Analytics must use only metadata. */
export function buildComponentQAAgentPayload(input: {
  component: ComponentDescriptor;
  frame: ComponentCanvasFrame;
  sourceRevision: string;
  screenshotPath?: string | null;
  diff: ComponentQADiff;
  a11y?: ComponentA11yResult | null;
  diagnostics?: readonly string[];
}): ComponentQAAgentPayload {
  const props = Object.entries(input.frame.props)
    .slice(0, 32)
    .map(
      ([name, value]) =>
        `- ${clampPromptPart(name, 120)}: ${clampPromptPart(displayStaticValue(value), 600)}`
    )
    .join('\n');
  const findings = (input.a11y?.findings ?? [])
    .slice(0, 16)
    .map((finding) => `- [${finding.impact}] ${clampPromptPart(finding.message, 600)}`)
    .join('\n');
  const diagnostics = (input.diagnostics ?? [])
    .slice(0, 16)
    .map((item) => `- ${clampPromptPart(item, 600)}`)
    .join('\n');
  const screenshot = input.screenshotPath
    ? `\nScreenshot path returned by Ship Studio: ${clampPromptPart(input.screenshotPath, 1000)}`
    : '';
  return {
    prompt:
      `Component QA failed for the explicit “${clampPromptPart(input.frame.name, 120)}” frame of ${clampPromptPart(input.component.name, 120)} (${input.component.dialect}).\n\n` +
      `Source definition: ${clampPromptPart(input.component.definition.file, 1000)}:${input.component.definition.line} (revision ${clampPromptPart(input.sourceRevision, 160)}).\n` +
      `Baseline state: ${input.diff.state}; threshold: ${input.diff.threshold}. ${input.diff.message}\n` +
      `${screenshot}\n\n` +
      `Explicit props:\n${props || '- (none authored; preserve component defaults)'}\n\n` +
      `Accessibility findings:\n${findings || '- none recorded'}\n\n` +
      `Diagnostics:\n${diagnostics || '- none recorded'}\n\n` +
      `Please inspect the referenced source definition and fix only the proven cause. Do not infer missing props, routes, or runtime state.`,
    metadata: {
      dialect: input.component.dialect,
      hasScreenshot: Boolean(input.screenshotPath),
      hasA11yFindings: Boolean(input.a11y?.findings.length),
      diffState: input.diff.state,
    },
  };
}

/** Project-scoped key; the raw path never appears in telemetry. */
export function componentQAStorageKey(projectIdentity: string): string {
  return `ship-studio.component-qa.v${COMPONENT_QA_VERSION}.${sha256(projectIdentity).slice(0, 24)}`;
}
