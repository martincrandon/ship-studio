import type { ComponentDescriptor, ComponentIndex, ComponentInstance, StaticValue } from './types';
import type { ComponentPreviewPreset } from './presets';
import { sha256 } from './ranges';

/** A deliberately small ceiling keeps the canvas responsive and prevents an
 * accidental Cartesian product from turning into a screenshot farm. */
export const COMPONENT_CANVAS_MAX_FRAMES = 12;

export type CanvasWidthMode = 'fit' | 'full' | 'fixed';
export type CanvasBackground = 'surface' | 'white' | 'black' | 'checkerboard';
export type CanvasFrameHeight = 240 | 360 | 480 | 640 | 800;

/** Project-scoped key; the raw workspace path never becomes a shared key. */
export function componentPreviewPresetStorageKey(projectIdentity: string): string {
  return `ship-studio.component-preview-presets.v1.${sha256(projectIdentity).slice(0, 24)}`;
}

export interface ComponentCanvasFrame {
  id: string;
  presetId: string | null;
  name: string;
  componentId: string;
  props: Record<string, StaticValue>;
  slots: Record<string, string>;
  widthMode: CanvasWidthMode;
  width: number | null;
  height: CanvasFrameHeight;
  background: CanvasBackground;
  breakpoint: string | null;
  locale: string | null;
  /** The source revision that the authored frame was last reviewed against. */
  sourceRevision: string;
}

export interface CanvasFrameOrphan {
  frame: ComponentCanvasFrame;
  reason: 'missing-component' | 'dialect-changed' | 'unknown-prop' | 'unknown-slot';
}

export interface ReconciledCanvasFrames {
  active: ComponentCanvasFrame[];
  orphaned: CanvasFrameOrphan[];
}

function defaultFrameName(component: ComponentDescriptor, count: number): string {
  return count === 0 ? 'Default' : `${component.name} ${count + 1}`;
}

function staticPropsFromInstance(
  instance: ComponentInstance | null | undefined
): Record<string, StaticValue> {
  if (!instance) return {};
  return Object.fromEntries(
    Object.entries(instance.props).flatMap(([name, expression]) =>
      expression.kind === 'static' ? [[name, expression.value]] : []
    )
  );
}

function staticSlotsFromInstance(
  instance: ComponentInstance | null | undefined
): Record<string, string> {
  if (!instance) return {};
  return Object.fromEntries(
    instance.slots.flatMap((slot) =>
      slot.sourceText !== undefined ? [[slot.name, slot.sourceText]] : []
    )
  );
}

/** Create a frame from explicit values only. No default prop is copied into
 * props: absence remains meaningful and is displayed as source/default. */
export function createComponentCanvasFrame(
  component: ComponentDescriptor,
  sourceRevision: string,
  count = 0,
  instance?: ComponentInstance | null,
  preset?: ComponentPreviewPreset | null
): ComponentCanvasFrame {
  const presentation = preset?.presentation;
  return {
    id: preset?.id ?? `frame-${sha256(`${component.id}:${sourceRevision}:${count}`).slice(0, 16)}`,
    presetId: preset?.id ?? null,
    name: preset?.name ?? defaultFrameName(component, count),
    componentId: component.id,
    props: preset?.props ?? staticPropsFromInstance(instance),
    slots: preset?.slots ?? staticSlotsFromInstance(instance),
    widthMode: presentation?.widthMode ?? 'fit',
    width: presentation?.width ?? null,
    height: presentation?.height ?? 480,
    background: presentation?.background ?? 'surface',
    breakpoint: presentation?.breakpoint ?? null,
    locale: presentation?.locale ?? null,
    sourceRevision: preset?.sourceRevision ?? sourceRevision,
  };
}

export function frameToPreviewPreset(
  frame: ComponentCanvasFrame,
  dialect: ComponentPreviewPreset['dialect']
): ComponentPreviewPreset {
  return {
    id: frame.presetId ?? frame.id,
    version: 1,
    componentId: frame.componentId,
    dialect,
    name: frame.name.trim() || 'Untitled frame',
    props: frame.props,
    slots: frame.slots,
    sourceRevision: frame.sourceRevision,
    presentation: {
      widthMode: frame.widthMode,
      width: frame.width,
      height: frame.height,
      background: frame.background,
      breakpoint: frame.breakpoint,
      locale: frame.locale,
    },
  };
}

export function previewPresetToFrame(
  preset: ComponentPreviewPreset,
  component: ComponentDescriptor,
  sourceRevision: string,
  count = 0
): ComponentCanvasFrame {
  return createComponentCanvasFrame(component, sourceRevision, count, null, preset);
}

export function addCanvasFrame(
  frames: readonly ComponentCanvasFrame[],
  frame: ComponentCanvasFrame
): { frames: ComponentCanvasFrame[]; refused: boolean } {
  if (frames.length >= COMPONENT_CANVAS_MAX_FRAMES) {
    return { frames: [...frames], refused: true };
  }
  return { frames: [...frames, frame], refused: false };
}

export function removeCanvasFrame(
  frames: readonly ComponentCanvasFrame[],
  frameId: string
): ComponentCanvasFrame[] {
  if (frames.length <= 1) return [...frames];
  return frames.filter((frame) => frame.id !== frameId);
}

export function moveCanvasFrame(
  frames: readonly ComponentCanvasFrame[],
  frameId: string,
  direction: 'up' | 'down'
): ComponentCanvasFrame[] {
  const index = frames.findIndex((frame) => frame.id === frameId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= frames.length) return [...frames];
  const next = [...frames];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Variant controls come exclusively from parser-proven finite choices. */
export function finiteVariantChoices(component: ComponentDescriptor) {
  const variantNames = new Set(component.variantProps);
  return component.props
    .filter((prop) => variantNames.has(prop.name) && prop.choices && prop.choices.length > 0)
    .map((prop) => ({ name: prop.name, choices: prop.choices! }));
}

export function reconcileCanvasFrames(
  frames: readonly ComponentCanvasFrame[],
  index: ComponentIndex
): ReconciledCanvasFrames {
  const active: ComponentCanvasFrame[] = [];
  const orphaned: CanvasFrameOrphan[] = [];
  for (const frame of frames) {
    const component = index.components.find((candidate) => candidate.id === frame.componentId);
    if (!component) {
      orphaned.push({ frame, reason: 'missing-component' });
      continue;
    }
    const frameDialect = frame.componentId.split(':', 1)[0];
    if (frameDialect && frameDialect !== component.dialect) {
      orphaned.push({ frame, reason: 'dialect-changed' });
      continue;
    }
    const propNames = new Set(component.props.map((prop) => prop.name));
    if (Object.keys(frame.props).some((name) => !propNames.has(name))) {
      orphaned.push({ frame, reason: 'unknown-prop' });
      continue;
    }
    const slotNames = new Set(component.slots.map((slot) => slot.name));
    if (Object.keys(frame.slots).some((name) => !slotNames.has(name))) {
      orphaned.push({ frame, reason: 'unknown-slot' });
      continue;
    }
    active.push(frame);
  }
  return { active, orphaned };
}

/** Stable identity for baseline comparisons and stale-revision detection. */
export function canvasFrameIdentity(frame: ComponentCanvasFrame, sourceRevision: string): string {
  return sha256(
    JSON.stringify({
      componentId: frame.componentId,
      name: frame.name,
      props: frame.props,
      slots: frame.slots,
      widthMode: frame.widthMode,
      width: frame.width,
      height: frame.height,
      background: frame.background,
      breakpoint: frame.breakpoint,
      locale: frame.locale,
      sourceRevision,
    })
  );
}
