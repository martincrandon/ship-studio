import type { ComponentDescriptor, ComponentPropDescriptor } from './types';

export const COMPONENT_PROPERTY_METADATA_VERSION = 1 as const;
export const COMPONENT_PROPERTY_METADATA_STORAGE_PREFIX = `shipstudio.component-property-metadata.v${COMPONENT_PROPERTY_METADATA_VERSION}:`;

/**
 * Presentation metadata is intentionally separate from framework source. It
 * can make a panel easier to use, but it must never add a prop or alter its
 * source contract. Hosts may load this shape from an explicit, project-scoped
 * companion file and pass it through the index builder.
 */
export interface ComponentPropertyPresentation {
  name: string;
  label?: string;
  group?: string;
  order?: number;
  description?: string;
}

export interface ComponentPresentationMetadata {
  componentId: string;
  properties: ComponentPropertyPresentation[];
}

export interface ComponentPropertyPresentationStore {
  version: typeof COMPONENT_PROPERTY_METADATA_VERSION;
  components: ComponentPresentationMetadata[];
}

export function componentPropertyMetadataStorageKey(projectPath: string): string {
  return `${COMPONENT_PROPERTY_METADATA_STORAGE_PREFIX}${encodeURIComponent(projectPath)}`;
}

export function emptyComponentPropertyPresentationStore(): ComponentPropertyPresentationStore {
  return { version: COMPONENT_PROPERTY_METADATA_VERSION, components: [] };
}

export function parseComponentPropertyPresentationStore(
  value: unknown
): ComponentPropertyPresentationStore {
  if (!value || typeof value !== 'object') return emptyComponentPropertyPresentationStore();
  const record = value as Record<string, unknown>;
  if (record.version !== COMPONENT_PROPERTY_METADATA_VERSION || !Array.isArray(record.components)) {
    return emptyComponentPropertyPresentationStore();
  }
  const components = record.components.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.componentId !== 'string' ||
      !item.componentId ||
      !Array.isArray(item.properties)
    ) {
      return [];
    }
    const properties = item.properties.flatMap((property) => {
      if (!property || typeof property !== 'object') return [];
      const entry = property as Record<string, unknown>;
      if (typeof entry.name !== 'string' || !entry.name) return [];
      return [
        {
          name: entry.name,
          ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
          ...(typeof entry.group === 'string' ? { group: entry.group } : {}),
          ...(typeof entry.order === 'number' && Number.isFinite(entry.order)
            ? { order: entry.order }
            : {}),
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        },
      ];
    });
    return [{ componentId: item.componentId, properties }];
  });
  return { version: COMPONENT_PROPERTY_METADATA_VERSION, components };
}

export function readComponentPropertyPresentationStore(
  storage: Pick<Storage, 'getItem'> | null | undefined,
  projectPath: string | null | undefined
): ComponentPropertyPresentationStore {
  if (!storage || !projectPath) return emptyComponentPropertyPresentationStore();
  const raw = storage.getItem(componentPropertyMetadataStorageKey(projectPath));
  if (!raw) return emptyComponentPropertyPresentationStore();
  try {
    return parseComponentPropertyPresentationStore(JSON.parse(raw));
  } catch {
    return emptyComponentPropertyPresentationStore();
  }
}

export function writeComponentPropertyPresentationStore(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  projectPath: string,
  store: ComponentPropertyPresentationStore
): void {
  if (!storage || !projectPath) return;
  const normalized = parseComponentPropertyPresentationStore(store);
  storage.setItem(componentPropertyMetadataStorageKey(projectPath), JSON.stringify(normalized));
}

export function mergePropertyPresentation(
  props: readonly ComponentPropDescriptor[],
  metadata: ComponentPresentationMetadata | null | undefined
): ComponentPropDescriptor[] {
  const byName = new Map(
    (metadata?.componentId ? metadata.properties : []).map((item) => [item.name, item])
  );
  return [...props]
    .map((prop) => {
      const presentation = byName.get(prop.name);
      if (!presentation) return prop;
      return {
        ...prop,
        ...(presentation.label !== undefined ? { label: presentation.label } : {}),
        ...(presentation.description !== undefined && !prop.description
          ? { description: presentation.description }
          : {}),
        ...(presentation.group !== undefined ? { group: presentation.group } : {}),
        ...(presentation.order !== undefined ? { order: presentation.order } : {}),
      };
    })
    .sort((left, right) => {
      const order =
        (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
      return order || left.name.localeCompare(right.name);
    });
}

/** Filter metadata to the source-declared props. Unknown entries are ignored. */
export function knownPropertyPresentation(
  component: ComponentDescriptor,
  metadata: ComponentPresentationMetadata | null | undefined
) {
  const names = new Set(component.props.map((prop) => prop.name));
  return (metadata?.properties ?? []).filter((item) => names.has(item.name));
}

/**
 * Replace one project's presentation entry without changing the source index.
 * Unknown props are discarded at this boundary so renamed/removed source props
 * can never become editable metadata by accident.
 */
export function upsertComponentPropertyPresentation(
  store: ComponentPropertyPresentationStore,
  component: ComponentDescriptor,
  presentation: ComponentPresentationMetadata
): ComponentPropertyPresentationStore {
  const known = new Set(component.props.map((prop) => prop.name));
  const properties = presentation.properties
    .filter((item) => known.has(item.name))
    .map((item) => ({
      name: item.name,
      ...(item.label?.trim() ? { label: item.label.trim() } : {}),
      ...(item.group?.trim() ? { group: item.group.trim() } : {}),
      ...(item.description?.trim() ? { description: item.description.trim() } : {}),
      ...(item.order !== undefined && Number.isFinite(item.order) ? { order: item.order } : {}),
    }));
  const components = store.components.filter((item) => item.componentId !== component.id);
  if (properties.length > 0) components.push({ componentId: component.id, properties });
  return { version: COMPONENT_PROPERTY_METADATA_VERSION, components };
}
