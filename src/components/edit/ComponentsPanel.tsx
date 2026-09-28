import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ChevronIcon,
  CloseIcon,
  ComponentsIcon,
  ErrorIcon,
  FolderOpenIcon,
  InfoIcon,
  LockedIcon,
  PackageIcon,
  PinIcon,
  ResetIcon,
  SearchIcon,
  WarningIcon,
} from '@/components/icons';
import type {
  ComponentBinding,
  ComponentDescriptor,
  ComponentInsertionAnchor,
  ComponentId,
  ComponentIndex,
  ComponentInstance,
  DuplicateComponentInput,
  RenameComponentInput,
  SourceRef,
  StaticValue,
} from '../../lib/components/types';
import {
  compareComponentLibrary,
  type ComponentIndexWithLibraries,
  type ComponentLibraryMetadata,
  type ComponentLibraryUpdateDiff,
  type LibraryForkInput,
} from '../../lib/components/libraries';
import { trackEvent } from '../../lib/analytics';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/EmptyState';
import { IconButton } from '../primitives/IconButton';
import { PanelResizeHandle } from '../primitives/PanelResizeHandle';
import { SearchField } from '../primitives/SearchField';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tooltip } from '../primitives/Tooltip';
import { ComponentDetails } from './ComponentDetails';
import {
  ComponentInstanceControls,
  type ComponentInstanceControlsProps,
} from './ComponentInstanceControls';
import { EditMainBanner, type EditMainState } from './EditMainBanner';
import { PixelLoaderRings } from '../workspace/PixelLoaderRings';
import { ComponentLibraryForkModal } from './ComponentLibraryForkModal';
import {
  mergePropertyPresentation,
  readComponentPropertyPresentationStore,
  upsertComponentPropertyPresentation,
  writeComponentPropertyPresentationStore,
  type ComponentPresentationMetadata,
  type ComponentPropertyPresentationStore,
} from '../../lib/components/property-metadata';
import { presentedComponentName } from '../../lib/components/component-name';

export interface ComponentsPanelProps {
  index: ComponentIndexWithLibraries | null;
  /** Project root used by source-backed property asset pickers. */
  projectPath?: string;
  loading?: boolean;
  error?: string | null;
  selectedComponentId: ComponentId | null;
  onSelect: (componentId: ComponentId | null) => void;
  /** When true, clicking a catalog row navigates to that component's canvas focus view. */
  componentsCanvasView?: boolean;
  onPlace: (
    componentId: ComponentId,
    props?: Record<string, StaticValue>,
    position?: ComponentInsertionAnchor['position']
  ) => void;
  placementAvailable?: boolean;
  onOpenSource: (source: SourceRef) => void;
  /** Navigates to the first-class Components workspace. */
  onOpenCanvas?: (componentId: ComponentId) => void;
  onDuplicate?: (input: Omit<DuplicateComponentInput, 'kind' | 'snapshot'>) => void | Promise<void>;
  onRename?: (input: Omit<RenameComponentInput, 'kind' | 'snapshot'>) => void | Promise<void>;
  onDelete?: (input: { componentId: ComponentId; removeAllUsages: true }) => void | Promise<void>;
  onForkLibrary?: (input: Omit<LibraryForkInput, 'newName'>) => void | Promise<void>;
  onRefresh: () => void;
  onSelectUsage: (instance: ComponentInstance) => void;
  onEditProp?: (
    instance: ComponentInstance,
    propName: string,
    value: StaticValue | null
  ) => void | Promise<void>;
  onEditSlot?: (
    instance: ComponentInstance,
    slotName: string,
    replacementSource: string
  ) => void | Promise<void>;
  onEditStructuredSlot?: ComponentInstanceControlsProps['onEditStructuredSlot'];
  onEditSlotChildMain?: ComponentInstanceControlsProps['onEditSlotChildMain'];
  onInline?: (instance: ComponentInstance) => void | Promise<void>;
  instancePropsBusy?: boolean;
  binding?: ComponentBinding;
  editMain?: EditMainState;
  pinned?: boolean;
  onTogglePin?: () => void;
  onClose?: () => void;
}

interface ComponentGroup {
  key: string;
  folder: string;
  kind: ComponentDescriptor['kind'];
  dialect: ComponentDescriptor['dialect'];
  components: ComponentDescriptor[];
}

interface ComponentTypeSection {
  key: string;
  dialect: ComponentDescriptor['dialect'];
  groups: ComponentGroup[];
}

interface CatalogSection {
  key: string;
  title: string;
  subtitle?: string;
  components: ComponentDescriptor[];
  library?: ComponentLibraryMetadata;
}

const COMPONENTS_PANEL_CATALOG_DEFAULT_WIDTH_PX = 300;
const COMPONENTS_PANEL_CATALOG_MIN_WIDTH_PX = 180;
const COMPONENTS_PANEL_DETAILS_MIN_WIDTH_PX = 240;
const COMPONENTS_PANEL_CATALOG_MAX_FALLBACK_WIDTH_PX = 420;
const COMPONENTS_PANEL_CATALOG_WIDTH_KEY = 'componentsPanelCatalogWidthV2';

function readCatalogWidth() {
  const saved = Number(localStorage.getItem(COMPONENTS_PANEL_CATALOG_WIDTH_KEY));
  return Number.isFinite(saved) && saved >= COMPONENTS_PANEL_CATALOG_MIN_WIDTH_PX
    ? Math.min(saved, COMPONENTS_PANEL_CATALOG_MAX_FALLBACK_WIDTH_PX)
    : COMPONENTS_PANEL_CATALOG_DEFAULT_WIDTH_PX;
}

function clampCatalogWidth(width: number, maxWidth: number) {
  return Math.max(
    COMPONENTS_PANEL_CATALOG_MIN_WIDTH_PX,
    Math.min(width, Math.max(COMPONENTS_PANEL_CATALOG_MIN_WIDTH_PX, maxWidth))
  );
}

function folderName(file: string) {
  const slash = file.lastIndexOf('/');
  return slash > 0 ? file.slice(0, slash) : 'Project root';
}

function kindLabel(kind: ComponentDescriptor['kind']) {
  return kind.replace('-', ' ');
}

function dialectLabel(dialect: ComponentDescriptor['dialect']) {
  if (dialect === 'web-component') return 'Web Component';
  if (dialect === 'react-native') return 'React Native';
  return dialect.charAt(0).toUpperCase() + dialect.slice(1);
}

function diagnosticText(diagnostic: unknown) {
  if (typeof diagnostic === 'string') return diagnostic;
  if (!diagnostic || typeof diagnostic !== 'object') return 'Index diagnostics are available.';
  const record = diagnostic as Record<string, unknown>;
  return typeof record.message === 'string'
    ? record.message
    : typeof record.reason === 'string'
      ? record.reason
      : 'Index diagnostics are available.';
}

function hasError(diagnostic: unknown) {
  return (
    !!diagnostic &&
    typeof diagnostic === 'object' &&
    (diagnostic as Record<string, unknown>).severity === 'error'
  );
}

function groupComponents(components: ComponentDescriptor[]) {
  const groups = new Map<string, ComponentGroup>();
  components.forEach((component) => {
    const folder = folderName(component.definition.file);
    const key = `${component.dialect}::${folder}::${component.kind}`;
    const group = groups.get(key);
    if (group) group.components.push(component);
    else {
      groups.set(key, {
        key,
        folder,
        kind: component.kind,
        dialect: component.dialect,
        components: [component],
      });
    }
  });

  return [...groups.values()].sort((a, b) =>
    `${a.dialect}/${a.folder}/${a.kind}`.localeCompare(`${b.dialect}/${b.folder}/${b.kind}`)
  );
}

function groupComponentsByDialect(
  components: ComponentDescriptor[],
  preferredDialect?: ComponentDescriptor['dialect'] | null
): ComponentTypeSection[] {
  const sections = new Map<ComponentDescriptor['dialect'], ComponentTypeSection>();
  for (const group of groupComponents(components)) {
    const section = sections.get(group.dialect);
    if (section) section.groups.push(group);
    else {
      sections.set(group.dialect, {
        key: group.dialect,
        dialect: group.dialect,
        groups: [group],
      });
    }
  }

  return [...sections.values()].sort((a, b) => {
    if (preferredDialect === a.dialect) return -1;
    if (preferredDialect === b.dialect) return 1;
    return dialectLabel(a.dialect).localeCompare(dialectLabel(b.dialect));
  });
}

function libraryMetaLabel(library: ComponentLibraryMetadata) {
  return [library.packageName, library.version ? `v${library.version}` : null]
    .filter(Boolean)
    .join(' · ');
}

function catalogSections(
  components: ComponentDescriptor[],
  libraries: readonly ComponentLibraryMetadata[]
): CatalogSection[] {
  const ownership = new Map<string, ComponentLibraryMetadata>();
  for (const library of libraries) {
    for (const componentId of library.componentIds) ownership.set(componentId, library);
  }
  const project = components.filter((component) => {
    const library = ownership.get(component.id);
    return !library || library.ownership === 'project';
  });
  const sections: CatalogSection[] = [];
  if (project.length > 0) {
    sections.push({ key: 'project', title: 'Project Components', components: project });
  }
  for (const library of libraries) {
    const libraryComponents = components.filter(
      (component) => library.ownership === 'library' && library.componentIds.includes(component.id)
    );
    if (libraryComponents.length === 0) continue;
    sections.push({
      key: `library:${library.id}`,
      title: 'Library Components',
      subtitle: libraryMetaLabel(library),
      components: libraryComponents,
      library,
    });
  }
  return sections;
}

function libraryBaselineKey(projectPath: string, libraryId: string) {
  return `shipstudio.components.library-baseline:${encodeURIComponent(projectPath)}:${encodeURIComponent(libraryId)}`;
}

function readLibraryBaseline(projectPath: string | undefined, libraryId: string) {
  if (!projectPath) return null;
  try {
    const raw = localStorage.getItem(libraryBaselineKey(projectPath, libraryId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ComponentLibraryMetadata;
    return parsed && parsed.id === libraryId && typeof parsed.packageName === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function saveLibraryBaseline(projectPath: string | undefined, library: ComponentLibraryMetadata) {
  if (!projectPath) return;
  localStorage.setItem(libraryBaselineKey(projectPath, library.id), JSON.stringify(library));
}

function matchesSearch(component: ComponentDescriptor, query: string) {
  if (!query) return true;
  const haystack = [
    component.name,
    component.definition.file,
    component.exportName,
    component.kind,
    component.dialect,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
  return haystack.includes(query);
}

function statusFor(component: ComponentDescriptor) {
  if ((component.diagnostics ?? []).some(hasError)) return 'error';
  if ((component.diagnostics ?? []).length > 0) return 'warning';
  if (!component.capabilities.place) return 'readonly';
  return 'ready';
}

function countBucket(count: number) {
  if (count <= 0) return '0';
  if (count <= 3) return '1-3';
  if (count <= 10) return '4-10';
  if (count <= 50) return '11-50';
  return '51+';
}

function capabilityCount(component: ComponentDescriptor) {
  return Object.values(component.capabilities).filter(Boolean).length;
}

function panelStatus(index: ComponentIndex | null, loading: boolean, error: string | null) {
  if (error) return 'error';
  if (loading) return 'loading';
  if (!index || index.components.length === 0) return 'empty';
  return index.partial ? 'partial' : 'ready';
}

function StatusBadge({ component }: { component: ComponentDescriptor }) {
  const status = statusFor(component);
  if (status === 'error') {
    return (
      <span className="ss-components-status-badge ss-components-status-badge--error">
        <ErrorIcon size={12} aria-hidden="true" /> Error
      </span>
    );
  }
  if (status === 'warning') {
    return (
      <span className="ss-components-status-badge ss-components-status-badge--warning">
        <WarningIcon size={12} aria-hidden="true" /> Partial
      </span>
    );
  }
  if (status === 'readonly') {
    return null;
  }
  return null;
}

function ComponentRow({
  component,
  selected,
  onSelect,
  navigateToCanvas,
}: {
  component: ComponentDescriptor;
  selected: boolean;
  onSelect: (componentId: ComponentId | null) => void;
  navigateToCanvas: boolean;
}) {
  const presentedName = presentedComponentName(component.name);

  return (
    <button
      type="button"
      className={`ss-components-row${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(navigateToCanvas || !selected ? component.id : null)}
      aria-pressed={selected}
      title={`${presentedName} · ${component.definition.file}`}
    >
      <span className="ss-components-row__icon" aria-hidden="true">
        <ComponentsIcon size={15} />
      </span>
      <span className="ss-components-row__copy">
        <span className="ss-components-row__name">{presentedName}</span>
      </span>
      <span className="ss-components-row__status">
        <StatusBadge component={component} />
        <span className="ss-components-row__count tabular-nums">{component.usageCount}</span>
      </span>
    </button>
  );
}

function Group({
  group,
  collapsed,
  selectedComponentId,
  onToggle,
  onSelect,
  navigateToCanvas,
}: {
  group: ComponentGroup;
  collapsed: boolean;
  selectedComponentId: ComponentId | null;
  onToggle: () => void;
  onSelect: (componentId: ComponentId | null) => void;
  navigateToCanvas: boolean;
}) {
  return (
    <section className="ss-components-group" aria-labelledby={`components-group-${group.key}`}>
      <button
        type="button"
        className="ss-components-group__header"
        onClick={onToggle}
        aria-expanded={!collapsed}
        id={`components-group-${group.key}`}
      >
        <ChevronIcon
          size={13}
          aria-hidden="true"
          className={`ss-components-group__chevron${collapsed ? '' : ' is-open'}`}
        />
        <FolderOpenIcon size={14} aria-hidden="true" />
        <span className="ss-components-group__name">{group.folder}</span>
        <span className="ss-components-group__kind">{kindLabel(group.kind)}</span>
        <span className="ss-components-group__count tabular-nums">{group.components.length}</span>
      </button>
      {!collapsed && (
        <div className="ss-components-group__rows">
          {group.components.map((component) => (
            <ComponentRow
              key={component.id}
              component={component}
              selected={component.id === selectedComponentId}
              onSelect={onSelect}
              navigateToCanvas={navigateToCanvas}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function LibraryOwnershipNotice({
  library,
  onFork,
}: {
  library: ComponentLibraryMetadata;
  onFork?: () => void;
}) {
  const knownMetadata = [
    library.version ? `Version ${library.version}` : null,
    library.repository ? `Source ${library.repository}` : null,
  ].filter(Boolean);
  return (
    <div className="ss-components-library-notice" role="note">
      <LockedIcon size={14} aria-hidden="true" />
      <div className="ss-components-library-notice__copy">
        <strong>Library-owned · read-only in this project</strong>
        <span>
          {library.packageName}
          {knownMetadata.length > 0 ? ` · ${knownMetadata.join(' · ')}` : ''}
        </span>
        <span>Open the owning source project to edit this definition.</span>
      </div>
      {onFork && (
        <Button
          variant="secondary"
          size="compact"
          className="ss-components-library-fork-action"
          onClick={onFork}
        >
          Copy to project
        </Button>
      )}
    </div>
  );
}

function LibraryUpdateCard({
  update,
  deferred = false,
  onAccept,
  onDefer,
}: {
  update: ComponentLibraryUpdateDiff;
  deferred?: boolean;
  onAccept: () => void;
  onDefer: () => void;
}) {
  return (
    <section
      className="ss-components-library-update"
      aria-labelledby={`library-update-${update.libraryId}`}
    >
      <div className="ss-components-library-update__heading">
        <div>
          <h3 id={`library-update-${update.libraryId}`}>Library update review</h3>
          <p>
            {update.packageName} · {update.fromVersion ?? 'unknown'} →{' '}
            {update.toVersion ?? 'unknown'}
          </p>
        </div>
        <span className="ss-components-status-badge ss-components-status-badge--warning">
          {deferred ? 'Deferred' : 'Review'}
        </span>
      </div>
      <div className="ss-components-library-update__changes">
        {update.changes.map((change, index) => (
          <div key={`${change.kind}-${change.detail}-${index}`}>
            <strong>{change.label}</strong>
            <span>{change.detail}</span>
          </div>
        ))}
      </div>
      <p className="ss-components-muted">
        Accept acknowledges the resolved package metadata only. Dependency and lockfile changes
        require a separate reviewed package-manager plan.
      </p>
      <div className="ss-components-library-update__actions">
        <Button variant="ghost" size="compact" onClick={onDefer}>
          {deferred ? 'Review again' : 'Defer'}
        </Button>
        <Button variant="secondary" size="compact" onClick={onAccept}>
          Accept review
        </Button>
      </div>
    </section>
  );
}

function BindingNotice({
  binding,
  instances,
  onSelectUsage,
}: {
  binding: ComponentBinding;
  instances: readonly ComponentInstance[];
  onSelectUsage: (instance: ComponentInstance) => void;
}) {
  if (binding.confidence === 'exact' || binding.confidence === 'none') return null;

  const ambiguous = binding.confidence === 'ambiguous';
  const candidates = binding.candidates ?? [];
  return (
    <div
      className={`ss-components-binding-notice${ambiguous ? ' ss-components-binding-notice--warning' : ''}`}
      role="note"
    >
      {ambiguous ? (
        <WarningIcon size={14} aria-hidden="true" />
      ) : (
        <InfoIcon size={14} aria-hidden="true" />
      )}
      <div>
        <strong>{ambiguous ? 'Choose a source invocation' : 'Definition identified'}</strong>
        <p>
          {ambiguous
            ? 'More than one invocation could match this rendered selection.'
            : 'The exact invocation could not be proven, so instance values stay read-only.'}
        </p>
        {ambiguous && candidates.length > 0 && (
          <div className="ss-components-binding-notice__candidates">
            {candidates.map((candidate) => {
              const instance = candidate.instanceId
                ? instances.find((item) => item.id === candidate.instanceId)
                : undefined;
              return instance ? (
                <button
                  key={`${candidate.source.file}:${candidate.source.start}`}
                  type="button"
                  className="ss-components-binding-notice__candidate"
                  onClick={() => onSelectUsage(instance)}
                >
                  {candidate.source.file}:{candidate.source.line}
                </button>
              ) : (
                <span
                  key={`${candidate.source.file}:${candidate.source.start}`}
                  className="ss-components-binding-notice__candidate ss-components-binding-notice__candidate--static"
                >
                  {candidate.source.file}:{candidate.source.line}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PanelState({
  loading,
  error,
  onRefresh,
}: {
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <div className="ss-components-state" data-testid="components-loading">
        <PixelLoaderRings size="lg" label="Loading components" />
        <span>Building component index…</span>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        className="ss-components-empty-state"
        icon={<ErrorIcon size={24} />}
        title="Components couldn't load"
        description={error}
        action={
          <Button variant="secondary" leftIcon={<ResetIcon size={14} />} onClick={onRefresh}>
            Try again
          </Button>
        }
      />
    );
  }

  return null;
}

/**
 * Read-only component catalog surface. It owns only search/group presentation;
 * indexing, binding, source navigation, and mutations remain host callbacks.
 */
export function ComponentsPanel({
  index,
  projectPath,
  loading = false,
  error = null,
  selectedComponentId,
  onSelect,
  componentsCanvasView = false,
  onPlace,
  placementAvailable = true,
  onOpenSource,
  onOpenCanvas,
  onDuplicate,
  onRename,
  onDelete,
  onForkLibrary,
  onRefresh,
  onSelectUsage,
  onEditProp,
  onEditSlot,
  onEditStructuredSlot,
  onEditSlotChildMain,
  onInline,
  instancePropsBusy = false,
  binding,
  editMain,
  pinned = false,
  onTogglePin,
  onClose,
}: ComponentsPanelProps) {
  const [query, setQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [catalogWidth, setCatalogWidth] = useState(readCatalogWidth);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [libraryForkOpen, setLibraryForkOpen] = useState(false);
  const [libraryBaselineVersion, setLibraryBaselineVersion] = useState(0);
  const [deferredLibraryIds, setDeferredLibraryIds] = useState<Set<string>>(new Set());
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const catalogRef = useRef<HTMLDivElement | null>(null);
  const panelOpenedRef = useRef(false);
  const selectionEventRef = useRef<string | null>(null);

  const [propertyPresentationStore, setPropertyPresentationStore] =
    useState<ComponentPropertyPresentationStore>(() =>
      readComponentPropertyPresentationStore(
        typeof localStorage === 'undefined' ? null : localStorage,
        projectPath
      )
    );
  useEffect(() => {
    // Project switches must never leak presentation metadata across projects.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPropertyPresentationStore(
      readComponentPropertyPresentationStore(
        typeof localStorage === 'undefined' ? null : localStorage,
        projectPath
      )
    );
  }, [projectPath]);
  const propertyPresentationByComponent = useMemo(
    () =>
      new Map(
        propertyPresentationStore.components.map((metadata) => [metadata.componentId, metadata])
      ),
    [propertyPresentationStore]
  );

  const filteredComponents = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const libraries = index?.libraries ?? [];
    return (index?.components ?? []).filter((component) => {
      if (matchesSearch(component, normalized)) return true;
      const library = libraries.find((candidate) => candidate.componentIds.includes(component.id));
      return library ? library.packageName.toLocaleLowerCase().includes(normalized) : false;
    });
  }, [index?.components, index?.libraries, query]);
  const libraries = index?.libraries ?? [];
  const sections = useMemo(
    () => catalogSections(filteredComponents, libraries),
    [filteredComponents, libraries]
  );
  const selectedSource =
    index?.components.find((component) => component.id === selectedComponentId) ?? null;
  const selected = selectedSource
    ? {
        ...selectedSource,
        props: mergePropertyPresentation(
          selectedSource.props,
          propertyPresentationByComponent.get(selectedSource.id)
        ),
      }
    : null;
  const savePropertyPresentation = (metadata: ComponentPresentationMetadata) => {
    if (!selectedSource) return;
    const next = upsertComponentPropertyPresentation(
      propertyPresentationStore,
      selectedSource,
      metadata
    );
    writeComponentPropertyPresentationStore(
      typeof localStorage === 'undefined' ? null : localStorage,
      projectPath ?? '',
      next
    );
    setPropertyPresentationStore(next);
  };
  const selectedLibrary = selected
    ? (libraries.find(
        (library) => library.ownership === 'library' && library.componentIds.includes(selected.id)
      ) ?? null)
    : null;
  const selectedLibraryReadOnly = selectedLibrary !== null;
  const libraryBaselines = useMemo(() => {
    const baselines = new Map<string, ComponentLibraryMetadata>();
    for (const library of libraries) {
      const baseline = readLibraryBaseline(projectPath, library.id);
      if (baseline) baselines.set(library.id, baseline);
    }
    return baselines;
  }, [libraries, libraryBaselineVersion, projectPath]);
  const libraryUpdates = useMemo(
    () =>
      libraries.flatMap((library) => {
        const baseline = libraryBaselines.get(library.id);
        if (!baseline) return [];
        const update = compareComponentLibrary(baseline, library);
        return update.changes.length > 0 ? [update] : [];
      }),
    [libraries, libraryBaselines]
  );
  const libraryUpdatesById = useMemo(
    () => new Map(libraryUpdates.map((update) => [update.libraryId, update])),
    [libraryUpdates]
  );
  const usages = selected
    ? (index?.instances ?? []).filter((instance) => instance.componentId === selected.id)
    : [];
  const selectedBinding =
    selected &&
    binding &&
    (('componentId' in binding && binding.componentId === selected.id) ||
      (binding.confidence === 'ambiguous' &&
        binding.candidates.some((candidate) => candidate.componentId === selected.id)))
      ? binding
      : undefined;
  const selectedInstance =
    selectedBinding && 'instanceId' in selectedBinding && selectedBinding.instanceId
      ? ((index?.instances ?? []).find((instance) => instance.id === selectedBinding.instanceId) ??
        null)
      : null;
  const openCanvas = useCallback(
    (componentId: ComponentId) => onOpenCanvas?.(componentId),
    [onOpenCanvas]
  );
  const partialDiagnostics = index?.diagnostics ?? [];
  const indexIsPartial = index?.partial ?? false;
  const editMainForSelected = selected && !selectedLibraryReadOnly ? editMain : undefined;
  const hasSelection = selected !== null;
  const catalogMaxWidth =
    workspaceWidth > 0
      ? Math.max(
          COMPONENTS_PANEL_CATALOG_MIN_WIDTH_PX,
          workspaceWidth - COMPONENTS_PANEL_DETAILS_MIN_WIDTH_PX
        )
      : COMPONENTS_PANEL_CATALOG_MAX_FALLBACK_WIDTH_PX;

  useEffect(() => {
    for (const library of libraries) {
      if (!readLibraryBaseline(projectPath, library.id)) saveLibraryBaseline(projectPath, library);
    }
  }, [libraries, projectPath]);

  const acceptLibraryUpdate = useCallback(
    (library: ComponentLibraryMetadata) => {
      saveLibraryBaseline(projectPath, library);
      setDeferredLibraryIds((current) => {
        if (!current.has(library.id)) return current;
        const next = new Set(current);
        next.delete(library.id);
        return next;
      });
      setLibraryBaselineVersion((version) => version + 1);
    },
    [projectPath]
  );

  const deferLibraryUpdate = useCallback((libraryId: string) => {
    setDeferredLibraryIds((current) => new Set(current).add(libraryId));
  }, []);

  useEffect(() => {
    if (panelOpenedRef.current) return;
    panelOpenedRef.current = true;
    const components = index?.components ?? [];
    const capabilities = components.reduce(
      (total, component) => total + capabilityCount(component),
      0
    );
    void trackEvent('components_panel_opened', {
      status: panelStatus(index, loading, error),
      dialect_count: new Set(index?.profile.dialects ?? []).size,
      catalog_count_bucket: countBucket(components.length),
      capability_count: capabilities,
    });
  }, [error, index, loading]);

  const handleSelectComponent = useCallback(
    (componentId: ComponentId | null) => {
      onSelect(componentId);
      if (componentId && componentsCanvasView) openCanvas(componentId);
      if (!componentId || !index) return;
      const component = index.components.find((item) => item.id === componentId);
      if (!component) return;
      const eventKey = `${index.revision}:${componentId}`;
      if (selectionEventRef.current === eventKey) return;
      selectionEventRef.current = eventKey;
      void trackEvent('component_selected', {
        dialect: component.dialect,
        status: statusFor(component),
        usage_count_bucket: countBucket(component.usageCount),
        capability_count: capabilityCount(component),
        has_instance_binding: component.capabilities.instanceBinding,
        has_place: component.capabilities.place,
      });
    },
    [componentsCanvasView, index, onSelect, openCanvas]
  );

  const handleSelectUsage = useCallback(
    (instance: ComponentInstance) => {
      const component = index?.components.find((item) => item.id === instance.componentId);
      if (component) {
        void trackEvent('component_usage_opened', {
          dialect: component.dialect,
          status: statusFor(component),
          usage_count_bucket: countBucket(component.usageCount),
          capability_count: capabilityCount(component),
        });
      }
      onSelectUsage(instance);
    },
    [index, onSelectUsage]
  );

  const measureWorkspace = useCallback(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const width = workspace.getBoundingClientRect().width;
    if (width <= 0) return;
    setWorkspaceWidth((current) => (current === width ? current : width));
  }, []);

  useEffect(() => {
    measureWorkspace();
    if (typeof ResizeObserver !== 'function') return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(measureWorkspace);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [measureWorkspace]);

  useEffect(() => {
    localStorage.setItem(COMPONENTS_PANEL_CATALOG_WIDTH_KEY, String(catalogWidth));
  }, [catalogWidth]);

  const resizeCatalog = useCallback(
    (clientX: number) => {
      const catalog = catalogRef.current;
      if (!catalog) return;
      const next = clientX - catalog.getBoundingClientRect().left;
      setCatalogWidth(clampCatalogWidth(next, catalogMaxWidth));
    },
    [catalogMaxWidth]
  );

  const resizeCatalogBy = useCallback(
    (delta: number) => {
      setCatalogWidth((current) => clampCatalogWidth(current + delta, catalogMaxWidth));
    },
    [catalogMaxWidth]
  );

  return (
    <div
      className={`ss-edit-panel ss-components-panel ss-components-panel--dockable${
        pinned ? ' ss-edit-panel--pinned' : ''
      }${hasSelection ? ' ss-components-panel--with-details' : ''}`}
      data-testid="components-panel"
      data-index-revision={index?.revision}
      aria-busy={loading}
    >
      <header className="ss-edit-panel__header" data-dockable-drag-handle>
        <span className="ss-edit-panel__title">Components</span>
        <span className="ss-edit-panel__header-actions">
          {onTogglePin && (
            <ToggleButton
              variant="ghost"
              size="compact"
              className="button--icon-only panel-pin-toggle"
              onClick={onTogglePin}
              title={pinned ? 'Unpin — float over the preview' : 'Pin to the window'}
              aria-label={pinned ? 'Unpin Components panel' : 'Pin Components panel to the window'}
              pressed={pinned}
              leftIcon={<PinIcon size={13} />}
            />
          )}
          {onClose && (
            <IconButton
              variant="ghost"
              size="compact"
              aria-label="Close Components panel"
              title="Close Components panel"
              icon={<CloseIcon size={14} />}
              onClick={onClose}
            />
          )}
        </span>
      </header>

      <div className="ss-edit-panel__body ss-components-panel__content">
        {!index || (loading && index.components.length === 0) ? (
          <PanelState loading={loading} error={error} onRefresh={onRefresh} />
        ) : (
          <div
            ref={workspaceRef}
            className={`ss-components-panel__workspace${
              hasSelection ? ' ss-components-panel__workspace--with-details' : ''
            }`}
            style={{ '--components-catalog-w': `${catalogWidth}px` } as CSSProperties}
          >
            <div ref={catalogRef} className="ss-components-panel__catalog">
              <div className="ss-components-panel__toolbar">
                <SearchField
                  className="ss-components-search"
                  aria-label="Search components"
                  placeholder={`Search ${index.components.length.toLocaleString()} components…`}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
                <Tooltip content="Refresh components index">
                  <IconButton
                    variant="ghost"
                    size="compact"
                    aria-label="Refresh components index"
                    icon={<ResetIcon size={14} />}
                    onClick={onRefresh}
                    disabled={loading}
                  />
                </Tooltip>
              </div>

              {partialDiagnostics.length > 0 && (
                <div className="ss-components-partial" role="status">
                  {indexIsPartial ? (
                    <WarningIcon size={14} aria-hidden="true" />
                  ) : (
                    <InfoIcon size={14} aria-hidden="true" />
                  )}
                  <span>
                    {indexIsPartial ? 'Partial index' : 'Index diagnostics'} ·{' '}
                    {partialDiagnostics.length.toLocaleString()}{' '}
                    {partialDiagnostics.length === 1 ? 'diagnostic' : 'diagnostics'}
                  </span>
                  <IconButton
                    variant="ghost"
                    size="compact"
                    aria-label={
                      diagnosticsOpen ? 'Hide index diagnostics' : 'View index diagnostics'
                    }
                    aria-expanded={diagnosticsOpen}
                    icon={<InfoIcon size={14} />}
                    onClick={() => setDiagnosticsOpen((open) => !open)}
                  />
                </div>
              )}

              {diagnosticsOpen && partialDiagnostics.length > 0 && (
                <div className="ss-components-diagnostics" aria-label="Index diagnostics">
                  {partialDiagnostics.map((diagnostic, index) => (
                    <div key={index} className="ss-components-diagnostic">
                      <InfoIcon size={13} aria-hidden="true" />
                      <span>{diagnosticText(diagnostic)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="ss-components-panel__list" aria-label="Component catalog">
                {libraryUpdates.length > 0 && (
                  <div className="ss-components-library-updates" aria-label="Library updates">
                    {libraryUpdates.map((update) => {
                      const library = libraries.find((item) => item.id === update.libraryId);
                      if (!library) return null;
                      return (
                        <LibraryUpdateCard
                          key={update.libraryId}
                          update={update}
                          deferred={deferredLibraryIds.has(update.libraryId)}
                          onAccept={() => acceptLibraryUpdate(library)}
                          onDefer={() => deferLibraryUpdate(update.libraryId)}
                        />
                      );
                    })}
                  </div>
                )}
                {filteredComponents.length === 0 ? (
                  <EmptyState
                    className="ss-components-empty-state"
                    icon={<SearchIcon size={22} />}
                    title={
                      index.components.length === 0
                        ? 'No components found'
                        : 'No matching components'
                    }
                    description={
                      index.components.length === 0
                        ? 'Native component definitions will appear here when the index finds them.'
                        : 'Try a different name, folder, kind, or framework.'
                    }
                    action={
                      query && (
                        <Button variant="ghost" onClick={() => setQuery('')}>
                          Clear search
                        </Button>
                      )
                    }
                  />
                ) : (
                  sections.map((section) => {
                    const typeSections = groupComponentsByDialect(
                      section.components,
                      section.key === 'project' ? index.profile.primaryDialect : undefined
                    );
                    return (
                      <section key={section.key} className="ss-components-catalog-section">
                        <header className="ss-components-catalog-section__header">
                          <div>
                            <h3>
                              {section.library && <PackageIcon size={13} aria-hidden="true" />}
                              {section.title}
                            </h3>
                            {section.subtitle && <span>{section.subtitle}</span>}
                          </div>
                          <span className="ss-components-count tabular-nums">
                            {section.components.length}
                          </span>
                        </header>
                        {section.library && libraryUpdatesById.has(section.library.id) && (
                          <span className="ss-components-catalog-section__update">
                            Update available · review above
                          </span>
                        )}
                        {typeSections.map((typeSection) => (
                          <section
                            key={`${section.key}:${typeSection.key}`}
                            className="ss-components-catalog-section ss-components-type-section"
                            aria-labelledby={`components-type-${section.key}-${typeSection.key}`}
                          >
                            <span
                              id={`components-type-${section.key}-${typeSection.key}`}
                              className={`ss-components-type-tag ss-components-type-tag--${typeSection.dialect}`}
                            >
                              {dialectLabel(typeSection.dialect)}
                            </span>
                            {typeSection.groups.map((group) => {
                              const groupKey = `${section.key}:${group.key}`;
                              return (
                                <Group
                                  key={groupKey}
                                  group={{ ...group, key: groupKey }}
                                  collapsed={collapsedGroups.has(groupKey)}
                                  selectedComponentId={selectedComponentId}
                                  onToggle={() =>
                                    setCollapsedGroups((current) => {
                                      const next = new Set(current);
                                      if (next.has(groupKey)) next.delete(groupKey);
                                      else next.add(groupKey);
                                      return next;
                                    })
                                  }
                                  onSelect={handleSelectComponent}
                                  navigateToCanvas={componentsCanvasView}
                                />
                              );
                            })}
                          </section>
                        ))}
                      </section>
                    );
                  })
                )}
              </div>
            </div>

            {selected && (
              <>
                <PanelResizeHandle
                  value={catalogWidth}
                  min={COMPONENTS_PANEL_CATALOG_MIN_WIDTH_PX}
                  max={catalogMaxWidth}
                  label="Resize component list"
                  className="ss-components-panel__catalog-resize-handle"
                  onResize={resizeCatalog}
                  onResizeBy={resizeCatalogBy}
                />
                <div className="ss-components-panel__selection">
                  {selectedLibrary && (
                    <LibraryOwnershipNotice
                      library={selectedLibrary}
                      onFork={onForkLibrary ? () => setLibraryForkOpen(true) : undefined}
                    />
                  )}
                  <EditMainBanner
                    component={selected}
                    usageCount={selected.usageCount}
                    state={editMainForSelected}
                  />
                  {selectedBinding && (
                    <BindingNotice
                      binding={selectedBinding}
                      instances={index?.instances ?? []}
                      onSelectUsage={handleSelectUsage}
                    />
                  )}
                  <ComponentDetails
                    key={selected.id}
                    component={selected}
                    projectPath={projectPath}
                    propertyPresentation={propertyPresentationByComponent.get(selected.id) ?? null}
                    propertyPresentationEditable={!selectedLibraryReadOnly}
                    onSavePropertyPresentation={
                      selectedLibraryReadOnly ? undefined : savePropertyPresentation
                    }
                    usages={usages}
                    placementAvailable={selectedLibraryReadOnly ? false : placementAvailable}
                    onPlace={onPlace}
                    onOpenSource={onOpenSource}
                    onDuplicate={selectedLibraryReadOnly ? undefined : onDuplicate}
                    onRename={selectedLibraryReadOnly ? undefined : onRename}
                    onDelete={selectedLibraryReadOnly ? undefined : onDelete}
                    onSelectUsage={handleSelectUsage}
                    onOpenCanvas={() => openCanvas(selected.id)}
                  />
                  {selectedBinding?.confidence === 'exact' && (
                    <ComponentInstanceControls
                      instance={selectedInstance}
                      component={selected}
                      projectPath={projectPath}
                      availableComponents={index?.components}
                      bindingConfidence={selectedBinding.confidence}
                      disabled={editMainForSelected?.active === true}
                      busy={instancePropsBusy}
                      onEditProp={
                        !selectedLibraryReadOnly && selected.capabilities.editStaticProps
                          ? onEditProp
                          : undefined
                      }
                      onEditSlot={
                        !selectedLibraryReadOnly && selected.capabilities.editSlots
                          ? onEditSlot
                          : undefined
                      }
                      onEditStructuredSlot={
                        !selectedLibraryReadOnly && selected.capabilities.editSlots
                          ? onEditStructuredSlot
                          : undefined
                      }
                      onEditSlotChildMain={
                        selectedLibraryReadOnly ? undefined : onEditSlotChildMain
                      }
                      onSelectSlotChild={(child) => {
                        const childInstance = index.instances.find(
                          (instance) => instance.id === child.instanceId
                        );
                        if (childInstance) handleSelectUsage(childInstance);
                      }}
                      onInline={
                        !selectedLibraryReadOnly &&
                        selected.capabilities.extract &&
                        selected.dialect === 'react'
                          ? onInline
                          : undefined
                      }
                      onOpenSource={onOpenSource}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {selected && selectedLibrary && onForkLibrary && (
        <ComponentLibraryForkModal
          component={selected}
          library={selectedLibrary}
          isOpen={libraryForkOpen}
          onClose={() => setLibraryForkOpen(false)}
          onFork={(input) => {
            setLibraryForkOpen(false);
            return onForkLibrary(input);
          }}
        />
      )}
    </div>
  );
}
