import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CameraIcon,
  CheckIcon,
  CodeIcon,
  ComponentsIcon,
  InfoIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from '@/components/icons';
import type {
  ComponentDescriptor,
  ComponentIndex,
  ComponentInstance,
  ComponentPropDescriptor,
  SourceRef,
  StaticValue,
} from '../../lib/components/types';
import {
  addCanvasFrame,
  canvasFrameIdentity,
  COMPONENT_CANVAS_MAX_FRAMES,
  componentPreviewPresetStorageKey,
  createComponentCanvasFrame,
  finiteVariantChoices,
  frameToPreviewPreset,
  moveCanvasFrame,
  previewPresetToFrame,
  removeCanvasFrame,
  type CanvasBackground,
  type CanvasFrameHeight,
  type CanvasWidthMode,
  type ComponentCanvasFrame,
} from '../../lib/components/canvas';
import {
  createComponentIsolatedRenderRequest,
  type ComponentIsolatedRendererCapability,
  type ComponentIsolatedRenderResult,
} from '../../lib/components/isolated-renderer';
import {
  buildComponentQAAgentPayload,
  compareComponentQABaseline,
  componentQAStorageKey,
  createComponentQABaseline,
  planComponentQAMatrix,
  readComponentQABaselineStore,
  uncoveredFiniteVariantChoices,
  writeComponentQABaselineStore,
  type ComponentA11yResult,
  type ComponentQABaseline,
  type ComponentQAMatrixPlan,
} from '../../lib/components/qa';
import {
  readComponentPreviewPresetStore,
  reconcileComponentPreviewPresets,
  writeComponentPreviewPresetStore,
  type OrphanedComponentPreviewPreset,
} from '../../lib/components/presets';
import { trackEvent } from '../../lib/analytics';
import { useOptionalToast } from '../../contexts/ToastContext';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ModalFrame } from '../primitives/ModalFrame';
import { TextField } from '../primitives/TextField';

export interface ComponentCanvasProps {
  component: ComponentDescriptor;
  index: ComponentIndex;
  isOpen: boolean;
  onClose: () => void;
  initialInstance?: ComponentInstance | null;
  usages?: readonly ComponentInstance[];
  onOpenSource: (source: SourceRef) => void;
  onSelectUsage?: (instance: ComponentInstance) => void;
  /** Only wire this when the host can prove that the selected frame is mounted. */
  onCaptureFrame?: (frame: ComponentCanvasFrame) => Promise<string | null>;
  /** The host may provide a real axe/runtime bridge when a dialect supports it. */
  onRunAccessibility?: (frame: ComponentCanvasFrame) => Promise<ComponentA11yResult | null>;
  /** A validated external host; never executes project modules in Ship Studio. */
  isolatedRenderer?: ComponentIsolatedRendererCapability | null;
  onSendToAgent?: (prompt: string) => void;
  /** Verified options from the preview host; absent means only neutral defaults. */
  breakpointOptions?: readonly CanvasOption[];
  localeOptions?: readonly CanvasOption[];
}

export interface CanvasOption {
  value: string;
  label: string;
}

const DEFAULT_BREAKPOINT_OPTIONS: readonly CanvasOption[] = [
  { value: '', label: 'Follow preview' },
];
const DEFAULT_LOCALE_OPTIONS: readonly CanvasOption[] = [{ value: '', label: 'Default locale' }];
const HEIGHT_OPTIONS: CanvasFrameHeight[] = [240, 360, 480, 640, 800];
const WIDTH_OPTIONS: Array<{ value: CanvasWidthMode; label: string }> = [
  { value: 'fit', label: 'Fit' },
  { value: 'full', label: 'Full' },
  { value: 'fixed', label: 'Fixed' },
];
const BACKGROUND_OPTIONS: Array<{ value: CanvasBackground; label: string }> = [
  { value: 'surface', label: 'Surface' },
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'checkerboard', label: 'Checkerboard' },
];

function valueLabel(value: StaticValue | undefined): string {
  if (!value) return 'Default / unset';
  if (value.kind === 'string') return value.value || 'Empty string';
  if (value.kind === 'number' || value.kind === 'boolean') return String(value.value);
  if (value.kind === 'null') return 'null';
  return JSON.stringify(value);
}

function encodedValue(value: StaticValue): string {
  return JSON.stringify(value);
}

function decodeChoice(value: string, choices: readonly StaticValue[]): StaticValue | undefined {
  return choices.find((choice) => encodedValue(choice) === value);
}

function supportedStaticControl(prop: ComponentPropDescriptor): boolean {
  return (
    prop.control === 'text' ||
    prop.control === 'number' ||
    prop.control === 'boolean' ||
    prop.control === 'select' ||
    prop.control === 'asset'
  );
}

function staticValueFromText(
  prop: ComponentPropDescriptor,
  value: string
): StaticValue | undefined {
  if (prop.control === 'number') {
    const parsed = Number(value);
    return value !== '' && Number.isFinite(parsed) ? { kind: 'number', value: parsed } : undefined;
  }
  return { kind: 'string', value };
}

function orphanReason(reason: OrphanedComponentPreviewPreset['reason']): string {
  return {
    'missing-component': 'The definition no longer exists at its saved source identity.',
    'dialect-changed': 'The definition dialect changed and cannot be retargeted safely.',
    'unknown-prop': 'A saved prop is no longer in the component contract.',
    'unknown-slot': 'A saved slot is no longer in the component contract.',
    'invalid-preset': 'The saved preset did not pass validation.',
  }[reason];
}

function frameState(
  frame: ComponentCanvasFrame,
  revision: string,
  baselines: ComponentQABaseline[],
  rendered?: ComponentIsolatedRenderResult
) {
  const baseline = baselines.find((entry) => entry.frameId === frame.id) ?? null;
  return {
    baseline,
    diff: compareComponentQABaseline(baseline, {
      frameIdentity: canvasFrameIdentity(frame, revision),
      sourceRevision: revision,
      currentFingerprint: rendered?.renderFingerprint,
      currentPixelDifference: rendered?.pixelDifference,
      currentComparedBaselineFingerprint: rendered?.comparedBaselineFingerprint,
    }),
  };
}

function FramePreview({
  component,
  frame,
  zoom,
  onOpenSource,
  rendered,
  renderError,
}: {
  component: ComponentDescriptor;
  frame: ComponentCanvasFrame;
  zoom: number;
  onOpenSource: (source: SourceRef) => void;
  rendered?: ComponentIsolatedRenderResult;
  renderError?: string;
}) {
  const width = frame.widthMode === 'fixed' && frame.width ? `${frame.width}px` : undefined;
  return (
    <div
      className={`ss-component-canvas-frame__preview ss-component-canvas-frame__preview--${frame.background}`}
      style={{ height: `${frame.height}px` }}
      data-testid={`component-canvas-preview-${frame.id}`}
    >
      <div
        className="ss-component-canvas-frame__preview-inner"
        style={{ width, transform: `scale(${zoom})` }}
      >
        {rendered ? (
          <img
            className="ss-component-canvas-frame__rendered-image"
            src={rendered.imageDataUrl}
            alt={`${component.name} · ${frame.name}`}
            width={rendered.width}
            height={rendered.height}
          />
        ) : component.capabilities.isolatedPreview ? (
          <div className="ss-component-canvas-frame__unavailable">
            <ComponentsIcon size={24} aria-hidden="true" />
            <strong>
              {renderError
                ? 'Isolated render failed closed'
                : 'Live component preview is not connected'}
            </strong>
            <span>
              {renderError ??
                'This project supports an isolated preview, but its preview connection is not available right now.'}
            </span>
          </div>
        ) : (
          <div className="ss-component-canvas-frame__unavailable">
            <InfoIcon size={24} aria-hidden="true" />
            <strong>This project has no isolated preview</strong>
            <span>
              Ship Studio can save this test case and its QA settings, but it cannot render the
              component here. Use a live usage to see it in the preview.
            </span>
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<CodeIcon size={13} />}
              onClick={() => onOpenSource(component.definition)}
            >
              Open definition source
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function FramePropsEditor({
  component,
  frame,
  onChange,
}: {
  component: ComponentDescriptor;
  frame: ComponentCanvasFrame;
  onChange: (props: Record<string, StaticValue>) => void;
}) {
  const update = (name: string, value: StaticValue | undefined) => {
    const next = { ...frame.props };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onChange(next);
  };
  return (
    <div className="ss-component-canvas-frame__fields" aria-label={`${frame.name} props`}>
      {component.props.map((prop) => {
        const value = frame.props[prop.name];
        if (!supportedStaticControl(prop)) {
          return (
            <div
              key={prop.name}
              className="ss-component-canvas-field ss-component-canvas-field--readonly"
            >
              <span>{prop.name}</span>
              <small>Source-only ({prop.typeText ?? 'unknown type'})</small>
            </div>
          );
        }
        if (prop.control === 'select' && prop.choices?.length) {
          return (
            <label key={prop.name} className="ss-component-canvas-field">
              <span>{prop.name}</span>
              <select
                aria-label={`Set test case ${prop.name}`}
                value={value ? encodedValue(value) : ''}
                onChange={(event) =>
                  update(prop.name, decodeChoice(event.currentTarget.value, prop.choices ?? []))
                }
              >
                <option value="">Default / unset</option>
                {prop.choices.map((choice) => (
                  <option key={encodedValue(choice)} value={encodedValue(choice)}>
                    {valueLabel(choice)}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        if (prop.control === 'boolean') {
          return (
            <label key={prop.name} className="ss-component-canvas-field">
              <span>{prop.name}</span>
              <select
                aria-label={`Set test case ${prop.name}`}
                value={value?.kind === 'boolean' ? String(value.value) : ''}
                onChange={(event) =>
                  update(
                    prop.name,
                    event.currentTarget.value === ''
                      ? undefined
                      : { kind: 'boolean', value: event.currentTarget.value === 'true' }
                  )
                }
              >
                <option value="">Default / unset</option>
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            </label>
          );
        }
        return (
          <label key={prop.name} className="ss-component-canvas-field">
            <span>{prop.name}</span>
            <TextField
              aria-label={`Set test case ${prop.name}`}
              type={prop.control === 'number' ? 'number' : 'text'}
              value={
                value?.kind === 'string' || value?.kind === 'number' ? String(value.value) : ''
              }
              placeholder="Default / unset"
              onChange={(event) =>
                update(prop.name, staticValueFromText(prop, event.currentTarget.value))
              }
            />
          </label>
        );
      })}
      {component.props.length === 0 && (
        <span className="ss-components-muted">No declared props.</span>
      )}
    </div>
  );
}

function ComponentCanvasFrameCard({
  component,
  index,
  frame,
  frameIndex,
  frameCount,
  zoom,
  baselines,
  rendered,
  renderError,
  a11y,
  onFrameChange,
  onMove,
  onRemove,
  onCapture,
  onRunA11y,
  onSendToAgent,
  onOpenSource,
  onSelectUsage,
  usages,
  breakpointOptions,
  localeOptions,
}: {
  component: ComponentDescriptor;
  index: ComponentIndex;
  frame: ComponentCanvasFrame;
  frameIndex: number;
  frameCount: number;
  zoom: number;
  baselines: ComponentQABaseline[];
  rendered?: ComponentIsolatedRenderResult;
  renderError?: string;
  a11y: ComponentA11yResult | null;
  onFrameChange: (frame: ComponentCanvasFrame) => void;
  onMove: (direction: 'up' | 'down') => void;
  onRemove: () => void;
  onCapture?: () => void;
  onRunA11y?: () => void;
  onSendToAgent?: () => void;
  onOpenSource: (source: SourceRef) => void;
  onSelectUsage?: (instance: ComponentInstance) => void;
  usages: readonly ComponentInstance[];
  breakpointOptions: readonly CanvasOption[];
  localeOptions: readonly CanvasOption[];
}) {
  const { baseline, diff } = frameState(frame, index.revision, baselines, rendered);
  const currentA11y =
    a11y?.frameId === frame.id && a11y.sourceRevision === index.revision ? a11y : null;
  const updatePresentation = <K extends keyof ComponentCanvasFrame>(
    key: K,
    value: ComponentCanvasFrame[K]
  ) => onFrameChange({ ...frame, [key]: value, sourceRevision: index.revision });
  const selectedUsage = usages[0];
  return (
    <article
      className="ss-component-canvas-frame"
      data-testid={`component-canvas-frame-${frame.id}`}
    >
      <header className="ss-component-canvas-frame__header">
        <div className="ss-component-canvas-frame__heading">
          <TextField
            aria-label="Test case name"
            value={frame.name}
            onChange={(event) => onFrameChange({ ...frame, name: event.currentTarget.value })}
          />
          <span
            className={`ss-component-canvas-qa-state ss-component-canvas-qa-state--${diff.state}`}
          >
            {diff.state.replace('-', ' ')}
          </span>
        </div>
        <div className="ss-component-canvas-frame__actions">
          <IconButton
            variant="ghost"
            size="compact"
            aria-label={`Move ${frame.name} up`}
            title="Move test case up"
            icon={<ArrowUpIcon size={13} />}
            disabled={frameIndex === 0}
            onClick={() => onMove('up')}
          />
          <IconButton
            variant="ghost"
            size="compact"
            aria-label={`Move ${frame.name} down`}
            title="Move test case down"
            icon={<ArrowDownIcon size={13} />}
            disabled={frameIndex === frameCount - 1}
            onClick={() => onMove('down')}
          />
          <IconButton
            variant="ghost"
            size="compact"
            aria-label={`Remove test case ${frame.name}`}
            title="Remove test case"
            icon={<TrashIcon size={13} />}
            disabled={frameCount <= 1}
            onClick={onRemove}
          />
        </div>
      </header>
      <div className="ss-component-canvas-frame__controls">
        <label>
          <span>Width</span>
          <select
            aria-label={`${frame.name} width mode`}
            value={frame.widthMode}
            onChange={(event) =>
              updatePresentation('widthMode', event.currentTarget.value as CanvasWidthMode)
            }
          >
            {WIDTH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {frame.widthMode === 'fixed' && (
          <label>
            <span>Width px</span>
            <TextField
              aria-label={`${frame.name} fixed width`}
              type="number"
              min={160}
              max={1600}
              value={frame.width ?? ''}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isFinite(value) && value >= 160 && value <= 1600)
                  updatePresentation('width', value);
              }}
            />
          </label>
        )}
        <label>
          <span>Height</span>
          <select
            aria-label={`${frame.name} height`}
            value={frame.height}
            onChange={(event) =>
              updatePresentation('height', Number(event.currentTarget.value) as CanvasFrameHeight)
            }
          >
            {HEIGHT_OPTIONS.map((height) => (
              <option key={height} value={height}>
                {height}px
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Background</span>
          <select
            aria-label={`${frame.name} background`}
            value={frame.background}
            onChange={(event) =>
              updatePresentation('background', event.currentTarget.value as CanvasBackground)
            }
          >
            {BACKGROUND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Breakpoint</span>
          <select
            aria-label={`${frame.name} breakpoint`}
            value={frame.breakpoint ?? ''}
            onChange={(event) =>
              updatePresentation('breakpoint', event.currentTarget.value || null)
            }
          >
            {breakpointOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Locale</span>
          <select
            aria-label={`${frame.name} locale`}
            value={frame.locale ?? ''}
            onChange={(event) => updatePresentation('locale', event.currentTarget.value || null)}
          >
            {localeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FramePreview
        component={component}
        frame={frame}
        zoom={zoom}
        onOpenSource={onOpenSource}
        rendered={rendered}
        renderError={renderError}
      />
      <section className="ss-component-canvas-frame__section" aria-label={`${frame.name} props`}>
        <h4>Props</h4>
        <FramePropsEditor
          component={component}
          frame={frame}
          onChange={(props) => onFrameChange({ ...frame, props, sourceRevision: index.revision })}
        />
      </section>
      {component.slots.length > 0 && (
        <section className="ss-component-canvas-frame__section" aria-label={`${frame.name} slots`}>
          <h4>Content slots</h4>
          {component.slots.map((slot) => (
            <label key={slot.name} className="ss-component-canvas-slot">
              <span>
                {slot.name}
                {slot.required ? ' · required' : ''}
              </span>
              <textarea
                value={frame.slots[slot.name] ?? ''}
                placeholder="No explicit content"
                onChange={(event) =>
                  onFrameChange({
                    ...frame,
                    slots: { ...frame.slots, [slot.name]: event.currentTarget.value },
                    sourceRevision: index.revision,
                  })
                }
              />
            </label>
          ))}
        </section>
      )}
      <section
        className="ss-component-canvas-frame__section ss-component-canvas-frame__qa"
        aria-label={`${frame.name} visual and accessibility checks`}
      >
        <div className="ss-component-canvas-frame__section-heading">
          <h4>Visual and accessibility checks</h4>
          <span>Threshold {diff.threshold}</span>
        </div>
        <p className="ss-components-muted">{diff.message}</p>
        <div className="ss-component-canvas-frame__qa-actions">
          <Button
            variant="secondary"
            size="compact"
            leftIcon={<CameraIcon size={13} />}
            disabled={!onCapture}
            title={
              onCapture
                ? 'Capture a screenshot from the connected preview'
                : 'An isolated preview connection is required'
            }
            onClick={onCapture}
          >
            {baseline ? 'Recapture baseline' : 'Capture baseline'}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            leftIcon={<CheckIcon size={13} />}
            disabled={!onRunA11y}
            title={
              onRunA11y
                ? 'Run accessibility checks for this test case'
                : 'Accessibility bridge unavailable for this dialect'
            }
            onClick={onRunA11y}
          >
            Run a11y checks
          </Button>
          <Button variant="ghost" size="compact" disabled={!onSendToAgent} onClick={onSendToAgent}>
            Send results to agent
          </Button>
        </div>
        {currentA11y ? (
          <div className="ss-component-canvas-a11y" role="status">
            {currentA11y.findings.length === 0 ? (
              <>
                <CheckIcon size={13} /> No findings at this revision.
              </>
            ) : (
              <>
                <WarningIcon size={13} /> {currentA11y.findings.length} finding
                {currentA11y.findings.length === 1 ? '' : 's'} recorded.
                <ul>
                  {currentA11y.findings.map((finding) => (
                    <li key={finding.id}>
                      [{finding.impact}] {finding.message}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <span className="ss-components-muted">No accessibility result for this revision.</span>
        )}
        <div className="ss-component-canvas-frame__qa-links">
          <Button
            variant="ghost"
            size="compact"
            leftIcon={<CodeIcon size={13} />}
            onClick={() => onOpenSource(component.definition)}
          >
            Open definition
          </Button>
          {selectedUsage && onSelectUsage && (
            <Button variant="ghost" size="compact" onClick={() => onSelectUsage(selectedUsage)}>
              Open live usage
            </Button>
          )}
        </div>
        {diff.state === 'stale' && (
          <p className="ss-component-canvas-warning">
            <WarningIcon size={13} /> Re-capture after reviewing source revision{' '}
            {index.revision.slice(0, 12)}.
          </p>
        )}
      </section>
    </article>
  );
}

/**
 * Explicit, bounded component review. It is intentionally a presentation and
 * review surface: project modules are never imported or executed here.
 */
export function ComponentCanvas({
  component,
  index,
  isOpen,
  onClose,
  initialInstance = null,
  usages = [],
  onOpenSource,
  onSelectUsage,
  onSendToAgent,
  breakpointOptions = DEFAULT_BREAKPOINT_OPTIONS,
  localeOptions = DEFAULT_LOCALE_OPTIONS,
  isolatedRenderer,
}: ComponentCanvasProps) {
  const { showToast } = useOptionalToast();
  const projectKey = index.profile.workspaceRoot || 'unknown-project';
  const presetKey = componentPreviewPresetStorageKey(projectKey);
  const qaKey = componentQAStorageKey(projectKey);
  const [frames, setFrames] = useState<ComponentCanvasFrame[]>([]);
  const [orphaned, setOrphaned] = useState<OrphanedComponentPreviewPreset[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  const [baselines, setBaselines] = useState<ComponentQABaseline[]>([]);
  const [a11y, setA11y] = useState<Record<string, ComponentA11yResult>>({});
  const [zoom, setZoom] = useState(1);
  const [matrixPlan, setMatrixPlan] = useState<ComponentQAMatrixPlan | null>(null);
  const [renderedFrames, setRenderedFrames] = useState<
    Record<string, ComponentIsolatedRenderResult>
  >({});
  const [renderErrors, setRenderErrors] = useState<Record<string, string>>({});
  const renderGenerationRef = useRef(0);
  const initializedCanvasKeyRef = useRef<string | null>(null);
  const [matrixRenders, setMatrixRenders] = useState<
    Array<{
      breakpoint: string | null;
      locale: string | null;
      result?: ComponentIsolatedRenderResult;
      error?: string;
    }>
  >([]);
  const [matrixRunning, setMatrixRunning] = useState(false);

  const canRenderFrames =
    Boolean(isolatedRenderer) && component.capabilities.isolatedPreview === true;
  const renderFrame = useCallback(
    async (
      frame: ComponentCanvasFrame,
      baselineFingerprint?: string
    ): Promise<ComponentIsolatedRenderResult | null> => {
      if (!isolatedRenderer || !canRenderFrames) return null;
      const request = createComponentIsolatedRenderRequest(
        frame,
        component,
        index.revision,
        isolatedRenderer.projectIdentity,
        baselineFingerprint
      );
      return isolatedRenderer.renderFrame(request);
    },
    [canRenderFrames, component, index.revision, isolatedRenderer]
  );

  // Repaint every explicit frame after a source revision changes. The
  // generation guard prevents a slow, superseded host response from painting
  // stale pixels over a newer definition.
  useEffect(() => {
    let cancelled = false;
    if (!isOpen || !canRenderFrames || frames.length === 0) {
      queueMicrotask(() => {
        if (cancelled) return;
        setRenderedFrames({});
        setRenderErrors({});
      });
      return () => {
        cancelled = true;
      };
    }
    const generation = (renderGenerationRef.current += 1);
    queueMicrotask(() => {
      if (cancelled || generation !== renderGenerationRef.current) return;
      setRenderedFrames({});
      setRenderErrors({});
    });
    void Promise.all(
      frames.map(async (frame) => {
        try {
          const baselineFingerprint = baselines.find(
            (baseline) => baseline.frameId === frame.id
          )?.renderFingerprint;
          return { frame, result: await renderFrame(frame, baselineFingerprint) } as const;
        } catch (error) {
          return {
            frame,
            error:
              error instanceof Error ? error.message : 'The isolated renderer refused this frame.',
          } as const;
        }
      })
    ).then((results) => {
      if (cancelled || generation !== renderGenerationRef.current) return;
      const rendered: Record<string, ComponentIsolatedRenderResult> = {};
      const errors: Record<string, string> = {};
      for (const result of results) {
        if ('result' in result && result.result) rendered[result.frame.id] = result.result;
        else if ('error' in result)
          errors[result.frame.id] = result.error ?? 'The isolated renderer refused this frame.';
      }
      setRenderedFrames(rendered);
      setRenderErrors(errors);
    });
    return () => {
      cancelled = true;
    };
  }, [baselines, canRenderFrames, frames, index.revision, isOpen, renderFrame]);

  useEffect(() => {
    if (!isOpen) {
      initializedCanvasKeyRef.current = null;
      return;
    }
    const canvasKey = `${presetKey}:${component.id}`;
    // Keep authored frames while Edit main advances the source revision. A
    // source refresh must repaint those frames, not silently replace them
    // from an older localStorage snapshot.
    if (initializedCanvasKeyRef.current === canvasKey) return;
    initializedCanvasKeyRef.current = canvasKey;
    const reconciled = reconcileComponentPreviewPresets(
      readComponentPreviewPresetStore(localStorage, presetKey),
      index
    );
    const restored = reconciled.active
      .filter((preset) => preset.componentId === component.id)
      .map((preset, position) => previewPresetToFrame(preset, component, index.revision, position));
    const nextFrames =
      restored.length > 0
        ? restored
        : [createComponentCanvasFrame(component, index.revision, 0, initialInstance)];
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setFrames(nextFrames);
      setSelectedFrameId(nextFrames[0]?.id ?? null);
      setOrphaned(reconciled.orphaned);
      setBaselines(readComponentQABaselineStore(localStorage, qaKey).baselines);
      setA11y({});
      setMatrixPlan(null);
    });
    return () => {
      cancelled = true;
    };
  }, [component, index, initialInstance, isOpen, presetKey, qaKey]);

  useEffect(() => {
    if (!isOpen || frames.length === 0) return;
    const store = readComponentPreviewPresetStore(localStorage, presetKey);
    const current = frames.map((frame) => frameToPreviewPreset(frame, component.dialect));
    writeComponentPreviewPresetStore(
      localStorage,
      {
        ...store,
        presets: [
          ...store.presets.filter((preset) => preset.componentId !== component.id),
          ...current,
        ],
      },
      presetKey
    );
  }, [component.dialect, component.id, frames, isOpen, presetKey]);

  const selectedFrame = frames.find((frame) => frame.id === selectedFrameId) ?? frames[0] ?? null;
  const variants = useMemo(() => finiteVariantChoices(component), [component]);
  const uncovered = useMemo(
    () => uncoveredFiniteVariantChoices(component, frames),
    [component, frames]
  );
  const updateFrame = useCallback(
    (next: ComponentCanvasFrame) =>
      setFrames((current) => current.map((frame) => (frame.id === next.id ? next : frame))),
    []
  );
  const addFrameFromSelected = useCallback(() => {
    if (!selectedFrame) return;
    const result = addCanvasFrame(frames, {
      ...selectedFrame,
      id: `${selectedFrame.id}-copy-${frames.length + 1}`,
      presetId: null,
      name: `${selectedFrame.name} copy`,
      sourceRevision: index.revision,
    });
    if (result.refused) {
      showToast(`Component review is capped at ${COMPONENT_CANVAS_MAX_FRAMES} test cases.`, 'info');
      return;
    }
    setFrames(result.frames);
    setSelectedFrameId(result.frames[result.frames.length - 1]?.id ?? null);
  }, [frames, index.revision, selectedFrame, showToast]);
  const saveBaseline = useCallback(
    async (frame: ComponentCanvasFrame) => {
      if (!canRenderFrames || !isolatedRenderer) {
        showToast(
          'A proven isolated renderer is required to capture a Component Canvas baseline.',
          'info'
        );
        return;
      }
      let rendered = renderedFrames[frame.id];
      if (!rendered) {
        try {
          const fresh = await renderFrame(frame);
          if (fresh) {
            rendered = fresh;
            setRenderedFrames((current) => ({ ...current, [frame.id]: fresh }));
          }
        } catch (error) {
          showToast(
            error instanceof Error ? error.message : 'The isolated renderer refused this frame.',
            'error'
          );
          return;
        }
      }
      if (
        !rendered ||
        rendered.frameId !== frame.id ||
        rendered.sourceRevision !== index.revision ||
        !rendered.screenshotPath ||
        !rendered.renderFingerprint
      ) {
        showToast(
          'The isolated renderer did not return a screenshot path and pixel fingerprint; baseline was not saved.',
          'info'
        );
        return;
      }
      const next = createComponentQABaseline(
        frame,
        rendered.screenshotPath,
        index.revision,
        canvasFrameIdentity(frame, index.revision),
        new Date().toISOString(),
        undefined,
        rendered?.renderFingerprint
      );
      setBaselines((current) => {
        const updated = [...current.filter((baseline) => baseline.frameId !== frame.id), next];
        writeComponentQABaselineStore(localStorage, qaKey, { version: 1, baselines: updated });
        return updated;
      });
      showToast(`Saved a baseline for ${frame.name}.`, 'success');
      void trackEvent('component_qa_baseline_saved', {
        dialect: component.dialect,
        has_screenshot: true,
        diff_state: 'baseline-saved',
      });
    },
    [
      canRenderFrames,
      component.dialect,
      index.revision,
      isolatedRenderer,
      qaKey,
      renderFrame,
      renderedFrames,
      showToast,
    ]
  );
  const runA11y = useCallback(
    async (frame: ComponentCanvasFrame) => {
      if (!isolatedRenderer?.runAccessibility || !canRenderFrames) return;
      let result: ComponentA11yResult;
      try {
        result = await isolatedRenderer.runAccessibility(
          createComponentIsolatedRenderRequest(
            frame,
            component,
            index.revision,
            isolatedRenderer.projectIdentity
          )
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : 'The accessibility host refused this frame.',
          'error'
        );
        return;
      }
      if (result.frameId !== frame.id || result.sourceRevision !== index.revision) {
        showToast('The accessibility result was stale and was discarded.', 'info');
        return;
      }
      setA11y((current) => ({ ...current, [frame.id]: result }));
      void trackEvent('component_qa_a11y_checked', {
        dialect: component.dialect,
        finding_count_bucket:
          result.findings.length === 0 ? '0' : result.findings.length <= 3 ? '1-3' : '4+',
      });
    },
    [canRenderFrames, component, index.revision, isolatedRenderer, showToast]
  );
  const sendToAgent = useCallback(
    (frame: ComponentCanvasFrame) => {
      const state = frameState(frame, index.revision, baselines, renderedFrames[frame.id]);
      const payload = buildComponentQAAgentPayload({
        component,
        frame,
        sourceRevision: index.revision,
        screenshotPath: state.baseline?.screenshotPath,
        diff: state.diff,
        a11y: a11y[frame.id] ?? null,
        diagnostics: component.diagnostics.map((diagnostic) => diagnostic.message),
      });
      onSendToAgent?.(payload.prompt);
      void trackEvent('component_qa_agent_handoff', payload.metadata);
    },
    [a11y, baselines, component, index.revision, onSendToAgent, renderedFrames]
  );
  const runMatrixPlan = useCallback(() => {
    const plan = planComponentQAMatrix({
      breakpoints: breakpointOptions.flatMap((option) => (option.value ? [option.value] : [])),
      locales: localeOptions.flatMap((option) => (option.value ? [option.value] : [])),
    });
    setMatrixPlan(plan);
    setMatrixRenders([]);
  }, [breakpointOptions, localeOptions]);
  const runMatrix = useCallback(async () => {
    if (!selectedFrame || !canRenderFrames) return;
    const plan =
      matrixPlan ??
      planComponentQAMatrix({
        breakpoints: breakpointOptions.flatMap((option) => (option.value ? [option.value] : [])),
        locales: localeOptions.flatMap((option) => (option.value ? [option.value] : [])),
      });
    if (plan.refused) {
      setMatrixPlan(plan);
      return;
    }
    setMatrixPlan(plan);
    setMatrixRunning(true);
    setMatrixRenders([]);
    const results = await Promise.all(
      plan.cases.map(async (item) => {
        try {
          const result = await renderFrame({
            ...selectedFrame,
            id: `${selectedFrame.id}:matrix:${item.breakpoint ?? 'default'}:${item.locale ?? 'default'}`,
            breakpoint: item.breakpoint,
            locale: item.locale,
          });
          return { ...item, result: result ?? undefined };
        } catch (error) {
          return {
            ...item,
            error:
              error instanceof Error ? error.message : 'The isolated renderer refused this case.',
          };
        }
      })
    );
    setMatrixRenders(results);
    setMatrixRunning(false);
  }, [breakpointOptions, canRenderFrames, localeOptions, matrixPlan, renderFrame, selectedFrame]);
  const hasVerifiedMatrixOptions =
    breakpointOptions.some((option) => option.value !== '') ||
    localeOptions.some((option) => option.value !== '');

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={
        <>
          <ComponentsIcon size={16} /> Component review · {component.name}
        </>
      }
      className="ss-component-canvas-modal"
    >
      <div className="ss-component-canvas" data-testid="component-canvas">
        <div className="ss-component-canvas__intro">
          <div>
            <h3>Review this component in known states</h3>
            <p>
              Create named test cases for different props, content, viewport sizes, and locales.
              Then capture a visual baseline or run accessibility checks when a live preview is
              connected.
            </p>
            <span>
              Test cases are saved locally, capped at {COMPONENT_CANVAS_MAX_FRAMES}, and never
              generate every possible combination automatically.
            </span>
          </div>
          <div className="ss-component-canvas__toolbar">
            <label>
              <span>Zoom</span>
              <select
                aria-label="Review preview zoom"
                value={zoom}
                onChange={(event) => setZoom(Number(event.currentTarget.value))}
              >
                <option value="0.75">75%</option>
                <option value="1">100%</option>
                <option value="1.25">125%</option>
              </select>
            </label>
            <Button
              variant="primary"
              size="compact"
              leftIcon={<PlusIcon size={13} />}
              onClick={addFrameFromSelected}
              disabled={!selectedFrame || frames.length >= COMPONENT_CANVAS_MAX_FRAMES}
            >
              Add test case
            </Button>
          </div>
        </div>
        {variants.length > 0 && (
          <section
            className="ss-component-canvas__variants"
            aria-label="Variant options found in source"
          >
            <div>
              <strong>Variant options found in source</strong>
              <span>Only literal choices that were found safely are shown.</span>
            </div>
            {variants.map((variant) => (
              <div key={variant.name} className="ss-component-canvas__variant-row">
                <code>{variant.name}</code>
                <span>{variant.choices.map(valueLabel).join(' · ')}</span>
              </div>
            ))}
            <p className="ss-components-muted">
              Choose values inside each test case. Ship Studio does not create every combination
              automatically.
            </p>
          </section>
        )}
        <div className="ss-component-canvas__matrix">
          <div>
            <strong>Test matrix</strong>
            <span>
              {hasVerifiedMatrixOptions
                ? 'Plan a small set of checks across the verified viewport and locale options.'
                : 'The live preview has not provided viewport or locale options.'}
            </span>
          </div>
          <Button
            variant="secondary"
            size="compact"
            onClick={runMatrixPlan}
            disabled={!hasVerifiedMatrixOptions}
            title={
              hasVerifiedMatrixOptions
                ? 'Plan a bounded matrix from verified options'
                : 'The host must provide verified options before planning a matrix'
            }
          >
            Plan test matrix
          </Button>
          {matrixPlan && (
            <div className="ss-component-canvas__matrix-result" role="status">
              {matrixPlan.refused ? (
                <>
                  <WarningIcon size={13} /> {matrixPlan.message}
                </>
              ) : (
                <>
                  <CheckIcon size={13} /> {matrixPlan.cases.length} cases ready:{' '}
                  {matrixPlan.cases
                    .map((item) => `${item.breakpoint ?? 'default'} / ${item.locale ?? 'default'}`)
                    .join(', ')}
                </>
              )}
            </div>
          )}
          {matrixPlan && !matrixPlan.refused && (
            <Button
              variant="secondary"
              size="compact"
              onClick={() => void runMatrix()}
              disabled={!canRenderFrames || !selectedFrame || matrixRunning}
              title={
                canRenderFrames
                  ? 'Render the selected test case across this bounded matrix'
                  : 'A proven isolated renderer is required to run matrix cases'
              }
            >
              {matrixRunning ? 'Rendering matrix…' : 'Render test matrix'}
            </Button>
          )}
          {matrixRenders.length > 0 && (
            <div className="ss-component-canvas__matrix-renders" aria-label="Matrix render results">
              {matrixRenders.map((entry) => (
                <div
                  key={`${entry.breakpoint ?? 'default'}:${entry.locale ?? 'default'}`}
                  className="ss-component-canvas__matrix-render"
                >
                  <span>
                    {entry.breakpoint ?? 'default'} / {entry.locale ?? 'default'}
                  </span>
                  {entry.result ? (
                    <img
                      src={entry.result.imageDataUrl}
                      alt={`Matrix render · ${entry.breakpoint ?? 'default'} · ${entry.locale ?? 'default'}`}
                    />
                  ) : (
                    <small>{entry.error ?? 'No render returned.'}</small>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {uncovered.length > 0 && (
          <div className="ss-component-canvas__coverage" role="status">
            <WarningIcon size={14} />
            <span>
              <strong>Uncovered finite choices:</strong>{' '}
              {uncovered.map((item) => `${item.prop}=${valueLabel(item.choice)}`).join(', ')}
            </span>
          </div>
        )}
        {orphaned.length > 0 && (
          <section className="ss-component-canvas__orphans" aria-label="Orphaned presets">
            <div>
              <WarningIcon size={14} />
              <strong>Orphaned presets</strong>
              <span>These were not retargeted after reindexing.</span>
            </div>
            {orphaned
              .filter((item) => item.preset.componentId === component.id)
              .map((item) => (
                <div key={item.preset.id} className="ss-component-canvas__orphan">
                  <span>{item.preset.name}</span>
                  <small>{orphanReason(item.reason)}</small>
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() =>
                      setOrphaned((current) =>
                        current.filter((candidate) => candidate.preset.id !== item.preset.id)
                      )
                    }
                  >
                    Dismiss
                  </Button>
                </div>
              ))}
          </section>
        )}
        <div
          className="ss-component-canvas__frame-tabs"
          role="tablist"
          aria-label="Saved test cases"
        >
          {frames.map((frame) => (
            <button
              key={frame.id}
              type="button"
              role="tab"
              aria-selected={frame.id === selectedFrame?.id}
              onClick={() => setSelectedFrameId(frame.id)}
            >
              {frame.name || 'Untitled test case'}
            </button>
          ))}
        </div>
        <section className="ss-component-canvas__frame-matrix" aria-label="Saved test cases">
          {frames.map((frame) => (
            <article key={frame.id} className="ss-component-canvas__matrix-frame">
              <strong>{frame.name || 'Untitled test case'}</strong>
              <FramePreview
                component={component}
                frame={frame}
                zoom={zoom}
                onOpenSource={onOpenSource}
                rendered={renderedFrames[frame.id]}
                renderError={renderErrors[frame.id]}
              />
            </article>
          ))}
        </section>
        {selectedFrame && (
          <ComponentCanvasFrameCard
            component={component}
            index={index}
            frame={selectedFrame}
            frameIndex={frames.indexOf(selectedFrame)}
            frameCount={frames.length}
            zoom={zoom}
            baselines={baselines}
            rendered={renderedFrames[selectedFrame.id]}
            renderError={renderErrors[selectedFrame.id]}
            a11y={a11y[selectedFrame.id] ?? null}
            onFrameChange={updateFrame}
            onMove={(direction) => {
              const moved = moveCanvasFrame(frames, selectedFrame.id, direction);
              setFrames(moved);
            }}
            onRemove={() => {
              const next = removeCanvasFrame(frames, selectedFrame.id);
              setFrames(next);
              setSelectedFrameId(next[0]?.id ?? null);
            }}
            onCapture={canRenderFrames ? () => void saveBaseline(selectedFrame) : undefined}
            onRunA11y={
              canRenderFrames && isolatedRenderer?.runAccessibility
                ? () => void runA11y(selectedFrame)
                : undefined
            }
            onSendToAgent={onSendToAgent ? () => sendToAgent(selectedFrame) : undefined}
            onOpenSource={onOpenSource}
            usages={usages}
            onSelectUsage={onSelectUsage}
            breakpointOptions={breakpointOptions}
            localeOptions={localeOptions}
          />
        )}
      </div>
    </ModalFrame>
  );
}
