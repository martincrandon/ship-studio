import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ChevronIcon,
  CloseIcon,
  ComponentsIcon,
  ErrorIcon,
  FolderOpenIcon,
  InfoIcon,
  PinIcon,
  ResetIcon,
  SearchIcon,
  WarningIcon,
} from '@/components/icons';
import type {
  ComponentBinding,
  ComponentDescriptor,
  ComponentId,
  ComponentIndex,
  ComponentInstance,
  SourceRef,
  StaticValue,
} from '../../lib/components/types';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/EmptyState';
import { IconButton } from '../primitives/IconButton';
import { PanelResizeHandle } from '../primitives/PanelResizeHandle';
import { Spinner } from '../primitives/Spinner';
import { SearchField } from '../primitives/SearchField';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tooltip } from '../primitives/Tooltip';
import { ComponentDetails } from './ComponentDetails';
import { ComponentInstanceControls } from './ComponentInstanceControls';
import { EditMainBanner, type EditMainState } from './EditMainBanner';

export interface ComponentsPanelProps {
  index: ComponentIndex | null;
  loading?: boolean;
  error?: string | null;
  selectedComponentId: ComponentId | null;
  onSelect: (componentId: ComponentId | null) => void;
  onPlace: (componentId: ComponentId, props?: Record<string, StaticValue>) => void;
  placementAvailable?: boolean;
  onOpenSource: (source: SourceRef) => void;
  onRefresh: () => void;
  onSelectUsage: (instance: ComponentInstance) => void;
  onEditProp?: (
    instance: ComponentInstance,
    propName: string,
    value: StaticValue
  ) => void | Promise<void>;
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

const COMPONENTS_PANEL_CATALOG_DEFAULT_WIDTH_PX = 275;
const COMPONENTS_PANEL_CATALOG_MIN_WIDTH_PX = 180;
const COMPONENTS_PANEL_DETAILS_MIN_WIDTH_PX = 240;
const COMPONENTS_PANEL_CATALOG_MAX_FALLBACK_WIDTH_PX = 420;
const COMPONENTS_PANEL_CATALOG_WIDTH_KEY = 'componentsPanelCatalogWidth';

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
    return <span className="ss-components-status-text">Read-only</span>;
  }
  return null;
}

function ComponentRow({
  component,
  selected,
  onSelect,
}: {
  component: ComponentDescriptor;
  selected: boolean;
  onSelect: (componentId: ComponentId | null) => void;
}) {
  return (
    <button
      type="button"
      className={`ss-components-row${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(selected ? null : component.id)}
      aria-pressed={selected}
      title={`${component.name} · ${component.definition.file}`}
    >
      <span className="ss-components-row__icon" aria-hidden="true">
        <ComponentsIcon size={15} />
      </span>
      <span className="ss-components-row__copy">
        <span className="ss-components-row__name">{component.name}</span>
        <span className="ss-components-row__meta">{component.definition.file}</span>
      </span>
      <span className="ss-components-row__status">
        <StatusBadge component={component} />
        <span className={`ss-components-row__type ss-components-row__type--${component.dialect}`}>
          {dialectLabel(component.dialect)}
        </span>
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
}: {
  group: ComponentGroup;
  collapsed: boolean;
  selectedComponentId: ComponentId | null;
  onToggle: () => void;
  onSelect: (componentId: ComponentId | null) => void;
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
        <span className="ss-components-group__kind">
          {dialectLabel(group.dialect)} · {kindLabel(group.kind)}
        </span>
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
            />
          ))}
        </div>
      )}
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
        <Spinner size="lg" label="Loading components" />
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
  loading = false,
  error = null,
  selectedComponentId,
  onSelect,
  onPlace,
  placementAvailable = true,
  onOpenSource,
  onRefresh,
  onSelectUsage,
  onEditProp,
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
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const catalogRef = useRef<HTMLDivElement | null>(null);

  const filteredComponents = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (index?.components ?? []).filter((component) => matchesSearch(component, normalized));
  }, [index?.components, query]);
  const groups = useMemo(() => groupComponents(filteredComponents), [filteredComponents]);
  const selected =
    index?.components.find((component) => component.id === selectedComponentId) ?? null;
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
  const partialDiagnostics = index?.diagnostics ?? [];
  const indexIsPartial = index?.partial ?? false;
  const editMainForSelected = selected ? editMain : undefined;
  const hasSelection = selected !== null;
  const catalogMaxWidth =
    workspaceWidth > 0
      ? Math.max(
          COMPONENTS_PANEL_CATALOG_MIN_WIDTH_PX,
          workspaceWidth - COMPONENTS_PANEL_DETAILS_MIN_WIDTH_PX
        )
      : COMPONENTS_PANEL_CATALOG_MAX_FALLBACK_WIDTH_PX;

  const measureWorkspace = useCallback(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const width = workspace.getBoundingClientRect().width;
    if (width <= 0) return;
    setWorkspaceWidth((current) => (current === width ? current : width));
    setCatalogWidth((current) => {
      const next = hasSelection
        ? clampCatalogWidth(current, width - COMPONENTS_PANEL_DETAILS_MIN_WIDTH_PX)
        : clampCatalogWidth(width, width);
      return next === current ? current : next;
    });
  }, [hasSelection]);

  useEffect(() => {
    measureWorkspace();
    if (typeof ResizeObserver !== 'function') return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(measureWorkspace);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [hasSelection, measureWorkspace]);

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
        <div className="ss-components-panel__title-wrap">
          <ComponentsIcon size={16} aria-hidden="true" />
          <span className="ss-edit-panel__title">Components</span>
        </div>
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
                  groups.map((group) => (
                    <Group
                      key={group.key}
                      group={group}
                      collapsed={collapsedGroups.has(group.key)}
                      selectedComponentId={selectedComponentId}
                      onToggle={() =>
                        setCollapsedGroups((current) => {
                          const next = new Set(current);
                          if (next.has(group.key)) next.delete(group.key);
                          else next.add(group.key);
                          return next;
                        })
                      }
                      onSelect={onSelect}
                    />
                  ))
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
                  <EditMainBanner
                    component={selected}
                    usageCount={selected.usageCount}
                    state={editMainForSelected}
                  />
                  {selectedBinding && (
                    <BindingNotice
                      binding={selectedBinding}
                      instances={index?.instances ?? []}
                      onSelectUsage={onSelectUsage}
                    />
                  )}
                  <ComponentDetails
                    key={selected.id}
                    component={selected}
                    usages={usages}
                    placementAvailable={placementAvailable}
                    onPlace={onPlace}
                    onOpenSource={onOpenSource}
                    onSelectUsage={onSelectUsage}
                  />
                  {selectedBinding?.confidence === 'exact' && (
                    <ComponentInstanceControls
                      instance={selectedInstance}
                      component={selected}
                      bindingConfidence={selectedBinding.confidence}
                      disabled={editMainForSelected?.active === true}
                      busy={instancePropsBusy}
                      onEditProp={selected.capabilities.editStaticProps ? onEditProp : undefined}
                      onOpenSource={onOpenSource}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
