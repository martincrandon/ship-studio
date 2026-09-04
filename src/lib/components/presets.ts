import type { ComponentIndex, StaticValue } from './types';

/** Bump only when the persisted presentation schema changes incompatibly. */
export const COMPONENT_PRESET_VERSION = 1 as const;
export const COMPONENT_PRESET_STORAGE_KEY = 'ship-studio.component-preview-presets.v1';

export interface ComponentPreviewPreset {
  id: string;
  version: typeof COMPONENT_PRESET_VERSION;
  componentId: string;
  dialect: ComponentIndex['components'][number]['dialect'];
  name: string;
  /** Explicit values only; these are never inferred from a component definition. */
  props: Record<string, StaticValue>;
  /** Explicit static slot source only; no runtime expressions or route data. */
  slots: Record<string, string>;
}

export interface ComponentPreviewPresetStore {
  version: typeof COMPONENT_PRESET_VERSION;
  presets: ComponentPreviewPreset[];
}

export interface OrphanedComponentPreviewPreset {
  preset: ComponentPreviewPreset;
  reason:
    | 'missing-component'
    | 'dialect-changed'
    | 'unknown-prop'
    | 'unknown-slot'
    | 'invalid-preset';
}

export interface ReconciledComponentPreviewPresets {
  active: ComponentPreviewPreset[];
  orphaned: OrphanedComponentPreviewPreset[];
}

function isStaticValue(value: unknown): value is StaticValue {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'string') return typeof record.value === 'string';
  if (record.kind === 'number')
    return typeof record.value === 'number' && Number.isFinite(record.value);
  if (record.kind === 'boolean') return typeof record.value === 'boolean';
  if (record.kind === 'null') return record.value === null;
  if (record.kind === 'array') {
    return Array.isArray(record.value) && record.value.every(isStaticValue);
  }
  if (record.kind === 'object') {
    return (
      !!record.value &&
      typeof record.value === 'object' &&
      !Array.isArray(record.value) &&
      Object.values(record.value as Record<string, unknown>).every(isStaticValue)
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parsePreset(value: unknown): ComponentPreviewPreset | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== COMPONENT_PRESET_VERSION ||
    typeof value.id !== 'string' ||
    typeof value.componentId !== 'string' ||
    typeof value.dialect !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.props) ||
    !isRecord(value.slots)
  ) {
    return null;
  }
  if (!Object.values(value.props).every(isStaticValue)) return null;
  if (!Object.values(value.slots).every((slot) => typeof slot === 'string')) return null;
  return {
    id: value.id,
    version: COMPONENT_PRESET_VERSION,
    componentId: value.componentId,
    dialect: value.dialect as ComponentPreviewPreset['dialect'],
    name: value.name,
    props: value.props as Record<string, StaticValue>,
    slots: value.slots as Record<string, string>,
  };
}

/** Parse persisted presentation metadata without ever importing or executing project code. */
export function parseComponentPreviewPresetStore(value: unknown): ComponentPreviewPresetStore {
  if (
    !isRecord(value) ||
    value.version !== COMPONENT_PRESET_VERSION ||
    !Array.isArray(value.presets)
  ) {
    return { version: COMPONENT_PRESET_VERSION, presets: [] };
  }
  return {
    version: COMPONENT_PRESET_VERSION,
    presets: value.presets.flatMap((preset) => {
      const parsed = parsePreset(preset);
      return parsed ? [parsed] : [];
    }),
  };
}

export function readComponentPreviewPresetStore(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage,
  key = COMPONENT_PRESET_STORAGE_KEY
): ComponentPreviewPresetStore {
  if (!storage) return { version: COMPONENT_PRESET_VERSION, presets: [] };
  try {
    const raw = storage.getItem(key);
    return raw
      ? parseComponentPreviewPresetStore(JSON.parse(raw))
      : { version: COMPONENT_PRESET_VERSION, presets: [] };
  } catch {
    return { version: COMPONENT_PRESET_VERSION, presets: [] };
  }
}

export function writeComponentPreviewPresetStore(
  storage: Pick<Storage, 'setItem'>,
  store: ComponentPreviewPresetStore,
  key = COMPONENT_PRESET_STORAGE_KEY
): void {
  const normalized = parseComponentPreviewPresetStore(store);
  storage.setItem(key, JSON.stringify(normalized));
}

/**
 * Keep valid presentation presets addressable after a reindex. A renamed or
 * removed definition is reported as orphaned rather than silently retargeted
 * by name, path, or a similarly shaped component.
 */
export function reconcileComponentPreviewPresets(
  store: ComponentPreviewPresetStore,
  index: ComponentIndex
): ReconciledComponentPreviewPresets {
  const active: ComponentPreviewPreset[] = [];
  const orphaned: OrphanedComponentPreviewPreset[] = [];
  for (const preset of store.presets) {
    const component = index.components.find((candidate) => candidate.id === preset.componentId);
    if (!component) {
      orphaned.push({ preset, reason: 'missing-component' });
      continue;
    }
    if (component.dialect !== preset.dialect) {
      orphaned.push({ preset, reason: 'dialect-changed' });
      continue;
    }
    const propNames = new Set(component.props.map((prop) => prop.name));
    if (Object.keys(preset.props).some((name) => !propNames.has(name))) {
      orphaned.push({ preset, reason: 'unknown-prop' });
      continue;
    }
    const slotNames = new Set(component.slots.map((slot) => slot.name));
    if (Object.keys(preset.slots).some((name) => !slotNames.has(name))) {
      orphaned.push({ preset, reason: 'unknown-slot' });
      continue;
    }
    active.push(preset);
  }
  return { active, orphaned };
}
