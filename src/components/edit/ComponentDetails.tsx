import { useMemo, useState } from 'react';
import {
  CheckIcon,
  CodeIcon,
  DuplicateIcon,
  EditFieldIcon,
  ErrorIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  InfoIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from '@/components/icons';
import type {
  ComponentDescriptor,
  ComponentInsertionAnchor,
  ComponentInstance,
  SourceRef,
  StaticValue,
} from '../../lib/components/types';
import { Button } from '../primitives/Button';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { TextField } from '../primitives/TextField';
import { ComponentDeleteModal } from './ComponentDeleteModal';
import { ComponentDuplicateModal } from './ComponentDuplicateModal';
import { ComponentRenameModal } from './ComponentRenameModal';

interface ComponentDetailsProps {
  component: ComponentDescriptor;
  usages?: readonly ComponentInstance[];
  placementAvailable?: boolean;
  onPlace: (
    componentId: ComponentDescriptor['id'],
    props?: Record<string, StaticValue>,
    position?: ComponentInsertionAnchor['position']
  ) => void;
  onOpenSource: (source: SourceRef) => void;
  onDuplicate?: (input: {
    componentId: ComponentDescriptor['id'];
    newName: string;
    destinationFile: string;
  }) => void | Promise<void>;
  onRename?: (input: {
    componentId: ComponentDescriptor['id'];
    newName: string;
  }) => void | Promise<void>;
  onDelete?: (input: {
    componentId: ComponentDescriptor['id'];
    removeAllUsages: true;
  }) => void | Promise<void>;
  onSelectUsage?: (instance: ComponentInstance) => void;
}

const CAPABILITY_LABELS = [
  ['catalog', 'Catalog'],
  ['usageGraph', 'Usage graph'],
  ['definitionBinding', 'Definition binding'],
  ['instanceBinding', 'Instance binding'],
  ['place', 'Place'],
  ['editStaticProps', 'Static props'],
  ['editSlots', 'Slots'],
  ['editMain', 'Edit main'],
  ['duplicateDefinition', 'Duplicate definition'],
  ['renameDefinition', 'Rename definition'],
  ['deleteDefinition', 'Delete definition'],
] as const;

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return 'Unset';
  if (typeof value === 'string') return value || 'Empty string';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const record = value as Record<string, unknown>;
  if (record && typeof record === 'object') {
    if (record.kind === 'static' && 'value' in record) return formatValue(record.value);
    if (record.kind === 'string') {
      return typeof record.value === 'string' ? record.value : 'Empty string';
    }
    if (record.kind === 'number' || record.kind === 'boolean') {
      return typeof record.value === 'number' || typeof record.value === 'boolean'
        ? String(record.value)
        : 'Unavailable';
    }
    if (record.kind === 'null') return 'null';
    if (record.kind === 'array' && Array.isArray(record.value)) {
      return `[${record.value.map((item) => formatValue(item)).join(', ')}]`;
    }
    if (record.kind === 'object' && record.value && typeof record.value === 'object') {
      return `{${Object.entries(record.value as Record<string, unknown>)
        .map(([key, item]) => `${key}: ${formatValue(item)}`)
        .join(', ')}}`;
    }
    for (const key of ['value', 'text', 'raw']) {
      if (key in record && record[key] !== value) return formatValue(record[key]);
    }
  }

  try {
    return JSON.stringify(value) ?? 'Unavailable';
  } catch {
    return 'Unavailable';
  }
}

function kindLabel(kind: ComponentDescriptor['kind']) {
  return kind.replace('-', ' ');
}

function dialectLabel(dialect: ComponentDescriptor['dialect']) {
  const labels: Record<ComponentDescriptor['dialect'], string> = {
    react: 'React',
    astro: 'Astro',
    vue: 'Vue',
    svelte: 'Svelte',
    shopify: 'Shopify',
    'web-component': 'Web Component',
    'react-native': 'React Native',
    flutter: 'Flutter',
  };
  return labels[dialect] ?? dialect;
}

function diagnosticText(diagnostic: unknown): string {
  if (typeof diagnostic === 'string') return diagnostic;
  if (!diagnostic || typeof diagnostic !== 'object') return 'Unsupported component metadata.';
  const record = diagnostic as Record<string, unknown>;
  for (const key of ['message', 'detail', 'reason', 'code']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return 'Unsupported component metadata.';
}

function diagnosticSeverity(diagnostic: unknown): 'error' | 'warning' | 'info' {
  if (!diagnostic || typeof diagnostic !== 'object') return 'warning';
  const severity = (diagnostic as Record<string, unknown>).severity;
  return severity === 'error' || severity === 'info' ? severity : 'warning';
}

function DiagnosticIcon({ severity }: { severity: 'error' | 'warning' | 'info' }) {
  if (severity === 'error') return <ErrorIcon size={14} aria-hidden="true" />;
  if (severity === 'info') return <InfoIcon size={14} aria-hidden="true" />;
  return <WarningIcon size={14} aria-hidden="true" />;
}

function SourceButton({
  source,
  onOpenSource,
}: {
  source: SourceRef;
  onOpenSource: (source: SourceRef) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="compact"
      className="ss-components-source-link"
      leftIcon={<CodeIcon size={14} />}
      onClick={() => onOpenSource(source)}
      title={`Open ${source.file}:${source.line}`}
    >
      <span className="ss-components-source-link__file">{source.file}</span>
      <span className="ss-components-source-link__line">:{source.line}</span>
      <ExternalLinkIcon size={12} aria-hidden="true" />
    </Button>
  );
}

function PropList({
  component,
  onOpenSource,
}: {
  component: ComponentDescriptor;
  onOpenSource: (source: SourceRef) => void;
}) {
  if (component.props.length === 0) {
    return <p className="ss-components-muted">No declared props.</p>;
  }

  return (
    <div className="ss-components-prop-list">
      {component.props.map((prop) => (
        <div key={prop.name} className="ss-components-prop-row">
          <div className="ss-components-prop-row__name">
            <span>{prop.name}</span>
            {prop.required && <span className="ss-components-required">Required</span>}
          </div>
          <div className="ss-components-prop-row__meta">
            <span className="ss-components-code-pill">{prop.typeText ?? prop.control}</span>
            {prop.defaultValue !== null && (
              <span className="ss-components-prop-row__default">
                Default: <code>{formatValue(prop.defaultValue)}</code>
              </span>
            )}
            {prop.choices && prop.choices.length > 0 && (
              <span className="ss-components-prop-row__choices">
                {prop.choices.map((choice) => formatValue(choice)).join(' · ')}
              </span>
            )}
            <SourceButton source={prop.source} onOpenSource={onOpenSource} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SlotList({ component }: { component: ComponentDescriptor }) {
  if (component.slots.length === 0) {
    return <p className="ss-components-muted">No declared slots.</p>;
  }

  return (
    <div className="ss-components-slot-list">
      {component.slots.map((slot) => (
        <div key={slot.name} className="ss-components-slot-row">
          <span className="ss-components-slot-row__name">{slot.name}</span>
          <span className="ss-components-slot-row__meta">
            {slot.required ? 'Required' : 'Optional'} · {slot.scoped ? 'Scoped' : 'Default content'}
          </span>
        </div>
      ))}
    </div>
  );
}

function CapabilityList({ component }: { component: ComponentDescriptor }) {
  return (
    <div className="ss-components-capability-list">
      {CAPABILITY_LABELS.map(([key, label]) => {
        const enabled = component.capabilities[key];
        return (
          <div
            key={key}
            className={`ss-components-capability${enabled ? '' : ' is-disabled'}`}
            aria-label={`${label}: ${enabled ? 'available' : 'unavailable'}`}
          >
            {enabled ? (
              <CheckIcon size={13} aria-hidden="true" />
            ) : (
              <span className="ss-components-capability__dash" aria-hidden="true">
                —
              </span>
            )}
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function UsageList({
  usages,
  onSelectUsage,
}: {
  usages: readonly ComponentInstance[];
  onSelectUsage?: (instance: ComponentInstance) => void;
}) {
  if (usages.length === 0) {
    return (
      <div className="ss-components-usage-empty">
        <InfoIcon size={16} aria-hidden="true" />
        <span>No source usages were returned for this definition.</span>
      </div>
    );
  }

  return (
    <div className="ss-components-usage-list">
      {usages.map((usage) => {
        const content = (
          <>
            <span className="ss-components-usage-row__icon" aria-hidden="true">
              <FolderOpenIcon size={14} />
            </span>
            <span className="ss-components-usage-row__source">
              <span>{usage.invocation.file}</span>
              <span className="ss-components-usage-row__line">:{usage.invocation.line}</span>
            </span>
            {usage.route && <span className="ss-components-usage-row__route">{usage.route}</span>}
          </>
        );

        return onSelectUsage ? (
          <button
            key={usage.id}
            type="button"
            className="ss-components-usage-row"
            onClick={() => onSelectUsage(usage)}
            aria-label={`Select usage at ${usage.invocation.file}:${usage.invocation.line}`}
            title={`Select usage at ${usage.invocation.file}:${usage.invocation.line}`}
          >
            {content}
          </button>
        ) : (
          <div key={usage.id} className="ss-components-usage-row ss-components-usage-row--static">
            {content}
          </div>
        );
      })}
    </div>
  );
}

const PLACEMENT_CONTROLS = new Set(['text', 'number', 'boolean', 'select', 'asset']);

function encodedChoice(value: StaticValue) {
  return JSON.stringify(value);
}

function PlacementSetup({
  component,
  onCancel,
  onPlace,
}: {
  component: ComponentDescriptor;
  onCancel: () => void;
  onPlace: (
    props: Record<string, StaticValue>,
    position: ComponentInsertionAnchor['position']
  ) => void;
}) {
  const required = useMemo(
    () => component.props.filter((prop) => prop.required && prop.defaultValue === null),
    [component.props]
  );
  const [values, setValues] = useState<Record<string, StaticValue>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [position, setPosition] = useState<ComponentInsertionAnchor['position']>('after');

  const setValue = (name: string, value: StaticValue | null) => {
    setValues((current) => {
      const next = { ...current };
      if (value === null) delete next[name];
      else next[name] = value;
      return next;
    });
  };
  const supported = required.every(
    (prop) =>
      PLACEMENT_CONTROLS.has(prop.control) &&
      (prop.control !== 'select' || (prop.choices?.length ?? 0) > 0)
  );
  const complete = supported && required.every((prop) => values[prop.name] !== undefined);

  return (
    <section className="ss-components-placement" aria-labelledby="component-placement-title">
      <div className="ss-components-placement__heading">
        <div>
          <h3 id="component-placement-title" className="ss-components-section-title">
            {required.length > 0 ? 'Required props' : 'Placement'}
          </h3>
          <p className="ss-components-muted">
            {required.length > 0
              ? 'Set explicit values before Ship Studio writes JSX.'
              : 'Choose where the component should be inserted.'}
          </p>
        </div>
        <span className="ss-components-count tabular-nums">{required.length}</span>
      </div>

      <label className="ss-components-placement__field">
        <span>Insertion position</span>
        <select
          aria-label="Choose insertion position"
          value={position}
          onChange={(event) =>
            setPosition(event.currentTarget.value as ComponentInsertionAnchor['position'])
          }
        >
          <option value="before">Before selected element</option>
          <option value="after">After selected element</option>
          <option value="inside">Inside selected element</option>
        </select>
      </label>

      <div className="ss-components-placement__fields">
        {required.map((prop) => {
          const value = values[prop.name];
          return (
            <label key={prop.name} className="ss-components-placement__field">
              <span>
                {prop.name} <span className="ss-components-required">Required</span>
              </span>
              {prop.control === 'boolean' ? (
                <select
                  aria-label={`Set required ${prop.name}`}
                  value={value?.kind === 'boolean' ? String(value.value) : ''}
                  onChange={(event) =>
                    setValue(
                      prop.name,
                      event.currentTarget.value === ''
                        ? null
                        : { kind: 'boolean', value: event.currentTarget.value === 'true' }
                    )
                  }
                >
                  <option value="">Choose…</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : prop.control === 'select' && prop.choices ? (
                <select
                  aria-label={`Set required ${prop.name}`}
                  value={value ? encodedChoice(value) : ''}
                  onChange={(event) => {
                    const selected = prop.choices?.find(
                      (choice) => encodedChoice(choice) === event.currentTarget.value
                    );
                    setValue(prop.name, selected ?? null);
                  }}
                >
                  <option value="">Choose…</option>
                  {prop.choices.map((choice) => (
                    <option key={encodedChoice(choice)} value={encodedChoice(choice)}>
                      {formatValue(choice)}
                    </option>
                  ))}
                </select>
              ) : PLACEMENT_CONTROLS.has(prop.control) ? (
                <TextField
                  aria-label={`Set required ${prop.name}`}
                  type={prop.control === 'number' ? 'number' : 'text'}
                  value={drafts[prop.name] ?? ''}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setDrafts((current) => ({ ...current, [prop.name]: next }));
                    if (prop.control === 'number') {
                      const parsed = Number(next);
                      setValue(
                        prop.name,
                        next !== '' && Number.isFinite(parsed)
                          ? { kind: 'number', value: parsed }
                          : null
                      );
                    } else {
                      setValue(prop.name, { kind: 'string', value: next });
                    }
                  }}
                />
              ) : (
                <span className="ss-components-placement__unsupported">
                  This prop type must be authored in source.
                </span>
              )}
            </label>
          );
        })}
      </div>

      <div className="ss-components-placement__actions">
        <Button variant="ghost" size="compact" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="compact"
          disabled={!complete}
          title={supported ? 'Insert this component' : 'A required prop is source-only'}
          onClick={() => onPlace(values, position)}
        >
          Insert component
        </Button>
      </div>
    </section>
  );
}

/** Definition details and usage graph for the currently selected component. */
export function ComponentDetails({
  component,
  usages = [],
  placementAvailable = true,
  onPlace,
  onOpenSource,
  onDuplicate,
  onRename,
  onDelete,
  onSelectUsage,
}: ComponentDetailsProps) {
  const diagnostics = component.diagnostics ?? [];
  const canPlace = component.capabilities.place && placementAvailable;
  const [placementOpen, setPlacementOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canDuplicate = component.capabilities.duplicateDefinition && onDuplicate !== undefined;
  const canRename = component.capabilities.renameDefinition && onRename !== undefined;
  const canDelete = component.capabilities.deleteDefinition && onDelete !== undefined;

  return (
    <section className="ss-components-details" data-testid="component-details">
      <header className="ss-components-details__header">
        <div className="ss-components-details__identity">
          <span className="ss-components-details__kind" aria-hidden="true">
            <CodeIcon size={16} />
          </span>
          <div className="ss-components-details__heading">
            <h2>{component.name}</h2>
            <p>
              {dialectLabel(component.dialect)} · {kindLabel(component.kind)}
            </p>
          </div>
        </div>
        <div className="ss-components-details__actions">
          <Button
            variant="secondary"
            size="compact"
            className="ss-components-action-hit"
            leftIcon={<CodeIcon size={14} />}
            onClick={() => onOpenSource(component.definition)}
          >
            Open source
          </Button>
          <Button
            variant="primary"
            size="compact"
            className="ss-components-action-hit"
            leftIcon={<PlusIcon size={14} />}
            disabled={!canPlace}
            title={
              canPlace
                ? 'Place this component'
                : component.capabilities.place
                  ? 'Turn on edit mode and select a source-backed element first'
                  : 'Placement is not supported for this component'
            }
            aria-expanded={placementOpen}
            onClick={() => setPlacementOpen((open) => !open)}
          >
            Place
          </Button>
          {onDuplicate && (
            <Button
              variant="secondary"
              size="compact"
              className="ss-components-action-hit ss-components-duplicate-action"
              leftIcon={<DuplicateIcon size={14} />}
              disabled={!canDuplicate}
              title={
                canDuplicate
                  ? 'Create a reviewed copy of this component definition'
                  : 'Definition duplication is not supported for this component'
              }
              aria-expanded={duplicateOpen}
              onClick={() => setDuplicateOpen(true)}
            >
              Duplicate
            </Button>
          )}
          {onRename && (
            <Button
              variant="secondary"
              size="compact"
              className="ss-components-action-hit ss-components-rename-action"
              leftIcon={<EditFieldIcon size={14} />}
              disabled={!canRename}
              title={
                canRename
                  ? 'Rename this component definition and its resolved references'
                  : 'Definition renaming is not supported for this component'
              }
              aria-expanded={renameOpen}
              onClick={() => setRenameOpen(true)}
            >
              Rename
            </Button>
          )}
          {onDelete && (
            <Button
              variant="danger"
              size="compact"
              className="ss-components-action-hit ss-components-delete-action"
              leftIcon={<TrashIcon size={14} />}
              disabled={!canDelete}
              title={
                canDelete
                  ? 'Delete this component definition and its resolved references'
                  : 'Definition deletion is not supported for this component'
              }
              aria-expanded={deleteOpen}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </header>

      <SourceButton source={component.definition} onOpenSource={onOpenSource} />

      {component.description && (
        <p className="ss-components-details__description">{component.description}</p>
      )}

      {placementOpen && (
        <PlacementSetup
          component={component}
          onCancel={() => setPlacementOpen(false)}
          onPlace={(props, position) => {
            setPlacementOpen(false);
            onPlace(component.id, props, position);
          }}
        />
      )}

      {onDuplicate && (
        <ComponentDuplicateModal
          component={component}
          isOpen={duplicateOpen}
          onClose={() => setDuplicateOpen(false)}
          onDuplicate={(input) => {
            setDuplicateOpen(false);
            return onDuplicate(input);
          }}
        />
      )}

      {onRename && (
        <ComponentRenameModal
          component={component}
          isOpen={renameOpen}
          onClose={() => setRenameOpen(false)}
          onRename={(input) => {
            setRenameOpen(false);
            return onRename(input);
          }}
        />
      )}

      {onDelete && (
        <ComponentDeleteModal
          component={component}
          isOpen={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onDelete={(input) => {
            setDeleteOpen(false);
            return onDelete(input);
          }}
        />
      )}

      <Tabs defaultValue="overview" size="compact">
        <TabsList aria-label={`${component.name} details`} className="ss-components-details__tabs">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="usages">
            Usages <span className="tabular-nums">{component.usageCount}</span>
          </TabsTab>
        </TabsList>

        <TabsPanel value="overview" className="ss-components-details__tab-panel">
          <div className="ss-components-meta-grid">
            <div>
              <span className="ss-components-meta-label">Definition</span>
              <span className="ss-components-meta-value ss-components-meta-value--code">
                {component.exportName ?? 'File component'}
              </span>
            </div>
            <div>
              <span className="ss-components-meta-label">Usages</span>
              <span className="ss-components-meta-value tabular-nums">{component.usageCount}</span>
            </div>
            <div>
              <span className="ss-components-meta-label">Capabilities</span>
              <span className="ss-components-meta-value">
                {component.capabilities.catalog ? 'Cataloged' : 'Read-only'}
              </span>
            </div>
          </div>

          <section className="ss-components-detail-section" aria-labelledby="component-props-title">
            <h3 id="component-props-title" className="ss-components-section-title">
              Props
            </h3>
            <PropList component={component} onOpenSource={onOpenSource} />
          </section>

          <section className="ss-components-detail-section" aria-labelledby="component-slots-title">
            <h3 id="component-slots-title" className="ss-components-section-title">
              Slots
            </h3>
            <SlotList component={component} />
          </section>

          {component.variantProps.length > 0 && (
            <section
              className="ss-components-detail-section"
              aria-labelledby="component-variants-title"
            >
              <h3 id="component-variants-title" className="ss-components-section-title">
                Variant props
              </h3>
              <div className="ss-components-chip-list">
                {component.variantProps.map((name) => (
                  <span key={name} className="ss-components-code-pill">
                    {name}
                  </span>
                ))}
              </div>
            </section>
          )}

          <section
            className="ss-components-detail-section"
            aria-labelledby="component-capabilities-title"
          >
            <h3 id="component-capabilities-title" className="ss-components-section-title">
              Support
            </h3>
            <CapabilityList component={component} />
          </section>

          {diagnostics.length > 0 && (
            <section
              className="ss-components-detail-section"
              aria-labelledby="component-diagnostics-title"
            >
              <h3 id="component-diagnostics-title" className="ss-components-section-title">
                Diagnostics <span className="tabular-nums">{diagnostics.length}</span>
              </h3>
              <div className="ss-components-diagnostics">
                {diagnostics.map((diagnostic, index) => {
                  const severity = diagnosticSeverity(diagnostic);
                  return (
                    <div
                      key={`${severity}-${index}`}
                      className={`ss-components-diagnostic ss-components-diagnostic--${severity}`}
                    >
                      <DiagnosticIcon severity={severity} />
                      <span>{diagnosticText(diagnostic)}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </TabsPanel>

        <TabsPanel value="usages" className="ss-components-details__tab-panel">
          <div className="ss-components-usage-heading">
            <div>
              <h3 className="ss-components-section-title">Source usages</h3>
              <p className="ss-components-muted">
                Select a known invocation to inspect its authored values.
              </p>
            </div>
            <span className="ss-components-count tabular-nums">{usages.length}</span>
          </div>
          <UsageList usages={usages} onSelectUsage={onSelectUsage} />
        </TabsPanel>
      </Tabs>
    </section>
  );
}
