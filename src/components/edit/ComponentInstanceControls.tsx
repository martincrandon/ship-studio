import { useEffect, useRef, useState } from 'react';
import { CodeIcon, ComponentsIcon, InfoIcon } from '@/components/icons';
import type {
  BindingConfidence,
  ComponentDescriptor,
  ComponentInstance,
  ComponentSlotChild,
  SourceRef,
  StaticValue,
} from '../../lib/components/types';
import { Button } from '../primitives/Button';
import { TextField } from '../primitives/TextField';

export interface ComponentInstanceControlsProps {
  instance: ComponentInstance | null;
  component?: ComponentDescriptor | null;
  bindingConfidence?: BindingConfidence;
  disabled?: boolean;
  busy?: boolean;
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
  onSelectSlotChild?: (child: ComponentSlotChild) => void;
  onInline?: (instance: ComponentInstance) => void | Promise<void>;
  onOpenSource?: (source: SourceRef) => void;
}

type ValueRecord = Record<string, unknown>;

function asRecord(value: unknown): ValueRecord | null {
  return value !== null && typeof value === 'object' ? (value as ValueRecord) : null;
}

function expressionKind(value: unknown): 'static' | 'dynamic' | 'unset' {
  if (value === undefined || value === null) return 'unset';
  const record = asRecord(value);
  if (!record) return 'static';
  if (record.kind === 'unset' || record.type === 'unset') return 'unset';
  if (record.kind === 'dynamic' || record.type === 'dynamic' || record.isStatic === false) {
    return 'dynamic';
  }
  if (
    record.kind === 'static' ||
    record.type === 'static' ||
    record.isStatic === true ||
    record.kind === 'string' ||
    record.kind === 'number' ||
    record.kind === 'boolean' ||
    record.kind === 'null' ||
    record.kind === 'array' ||
    record.kind === 'object'
  ) {
    return 'static';
  }
  // Unknown expression shapes are deliberately conservative. An unfamiliar
  // AST node must never be presented as an editable static value.
  return 'dynamic';
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return 'Unset';
  if (typeof value === 'string') return value || 'Empty string';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const record = asRecord(value);
  if (record) {
    if (record.kind === 'unset') return 'Unset';
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
    if (record.kind === 'dynamic' && typeof record.text === 'string') return record.text;
    for (const key of ['value', 'text', 'code', 'raw', 'expression']) {
      if (key in record && record[key] !== value) return formatValue(record[key]);
    }
  }

  try {
    const encoded = JSON.stringify(value);
    return encoded ?? 'Unavailable';
  } catch {
    return 'Unavailable';
  }
}

function sourceLabel(source: SourceRef) {
  return `${source.file}:${source.line}`;
}

function valueForExpression(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if (record.kind === 'static' && 'value' in record) return record.value;
  if (
    record.kind !== 'string' &&
    record.kind !== 'number' &&
    record.kind !== 'boolean' &&
    record.kind !== 'null' &&
    record.kind !== 'array' &&
    record.kind !== 'object' &&
    'value' in record &&
    record.value !== value
  ) {
    return valueForExpression(record.value);
  }
  return value;
}

function staticValueForInput(
  control: 'text' | 'number' | 'asset',
  value: string
): StaticValue | null {
  if (control === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? { kind: 'number', value: parsed } : null;
  }
  return { kind: 'string', value };
}

function isEditableControl(control: ComponentDescriptor['props'][number]['control']) {
  return (
    control === 'text' ||
    control === 'number' ||
    control === 'boolean' ||
    control === 'select' ||
    control === 'asset'
  );
}

function encodeChoice(choice: unknown) {
  try {
    return JSON.stringify(choice);
  } catch {
    return String(choice);
  }
}

function decodeChoice(value: string, choices: unknown[]): StaticValue | null {
  const choice = choices.find((candidate) => encodeChoice(candidate) === value);
  return choice === undefined ? null : (choice as StaticValue);
}

function draftValue(value: unknown): string {
  const unwrapped = valueForExpression(value);
  const record = asRecord(unwrapped);
  if (record?.kind === 'string' || record?.kind === 'number') return String(record.value);
  if (typeof unwrapped === 'string' || typeof unwrapped === 'number') return String(unwrapped);
  return '';
}

function booleanValue(value: unknown) {
  const unwrapped = valueForExpression(value);
  const record = asRecord(unwrapped);
  return record?.kind === 'boolean' ? record.value === true : unwrapped === true;
}

function dynamicReason(value: unknown): string | null {
  const record = asRecord(value);
  return record?.kind === 'dynamic' && typeof record.reason === 'string' ? record.reason : null;
}

function InstancePropRow({
  instance,
  name,
  descriptor,
  value,
  disabled,
  busy,
  onEditProp,
  onOpenSource,
}: {
  instance: ComponentInstance;
  name: string;
  descriptor: ComponentDescriptor['props'][number] | undefined;
  value: unknown;
  disabled: boolean;
  busy: boolean;
  onEditProp?: (
    instance: ComponentInstance,
    propName: string,
    value: StaticValue | null
  ) => void | Promise<void>;
  onOpenSource?: (source: SourceRef) => void;
}) {
  const kind = expressionKind(value);
  const control = descriptor?.control ?? 'readonly';
  const editable = Boolean(onEditProp) && kind !== 'dynamic' && isEditableControl(control);
  const sourceValue = valueForExpression(value);
  const initialDraft = draftValue(value);
  const [draft, setDraft] = useState(initialDraft);
  const dirtyRef = useRef(false);

  const commitText = () => {
    if (!editable || !onEditProp || !dirtyRef.current) return;
    const next = staticValueForInput(
      control === 'asset' ? 'asset' : control === 'number' ? 'number' : 'text',
      draft
    );
    if (next !== null) {
      dirtyRef.current = false;
      void onEditProp(instance, name, next);
    }
  };

  const commitChoice = (next: StaticValue | null) => {
    if (!editable || !onEditProp) return;
    void onEditProp(instance, name, next);
  };

  const reset = () => {
    if (!editable || !onEditProp || descriptor?.required || kind === 'unset') return;
    dirtyRef.current = false;
    void onEditProp(instance, name, null);
  };

  const input =
    editable && descriptor ? (
      control === 'boolean' ? (
        descriptor.required ? (
          <label className="ss-components-instance__boolean">
            <input
              type="checkbox"
              aria-label={`Set ${name}`}
              checked={booleanValue(value)}
              onChange={(event) =>
                commitChoice({ kind: 'boolean', value: event.currentTarget.checked })
              }
              disabled={disabled || busy}
            />
            <span>{booleanValue(value) ? 'true' : 'false'}</span>
          </label>
        ) : (
          <select
            className="ss-components-instance__select"
            aria-label={`Set ${name}`}
            value={kind === 'unset' ? '' : booleanValue(value) ? 'true' : 'false'}
            onChange={(event) => {
              const selected = event.currentTarget.value;
              commitChoice(
                selected === '' ? null : { kind: 'boolean', value: selected === 'true' }
              );
            }}
            disabled={disabled || busy}
          >
            <option value="">Default</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        )
      ) : control === 'select' && descriptor.choices ? (
        <select
          className="ss-components-instance__select"
          aria-label={`Set ${name}`}
          value={sourceValue === undefined || sourceValue === null ? '' : encodeChoice(sourceValue)}
          onChange={(event) => {
            const selected = event.currentTarget.value;
            commitChoice(selected === '' ? null : decodeChoice(selected, descriptor.choices ?? []));
          }}
          disabled={disabled || busy}
        >
          <option value="">Unset</option>
          {descriptor.choices.map((choice) => (
            <option key={encodeChoice(choice)} value={encodeChoice(choice)}>
              {formatValue(choice)}
            </option>
          ))}
        </select>
      ) : (
        <TextField
          className="ss-components-instance__input"
          aria-label={`Set ${name}`}
          type={control === 'number' ? 'number' : 'text'}
          value={draft}
          placeholder="Unset"
          onChange={(event) => {
            dirtyRef.current = true;
            setDraft(event.currentTarget.value);
          }}
          onBlur={commitText}
          disabled={disabled || busy}
        />
      )
    ) : (
      <code
        className={`ss-components-instance__value ss-components-instance__value--${kind}`}
        title={formatValue(value)}
      >
        {formatValue(value)}
      </code>
    );

  return (
    <div className="ss-components-instance__row">
      <div className="ss-components-instance__label">
        <span>{name}</span>
        {descriptor?.required && <span className="ss-components-required">Required</span>}
      </div>
      <div className="ss-components-instance__value-wrap">
        {input}
        {kind === 'dynamic' && (
          <span className="ss-components-instance__state">
            Dynamic · {dynamicReason(value) ?? 'source only'}
          </span>
        )}
        {kind === 'unset' &&
          descriptor?.defaultValue !== null &&
          descriptor?.defaultValue !== undefined && (
            <span className="ss-components-instance__state">
              Default: {formatValue(descriptor.defaultValue)}
            </span>
          )}
        {kind === 'dynamic' && onOpenSource && (
          <Button
            variant="ghost"
            size="compact"
            className="ss-components-instance__source-button"
            leftIcon={<CodeIcon size={13} />}
            onClick={() => onOpenSource(instance.invocation)}
          >
            Open source
          </Button>
        )}
        {editable && kind !== 'unset' && !descriptor?.required && (
          <Button
            variant="ghost"
            size="compact"
            className="ss-components-instance__reset-button"
            onClick={reset}
            disabled={disabled || busy}
            aria-label={`Reset ${name}`}
            title={`Reset ${name} to its component default`}
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}

function InstanceSlotRow({
  instance,
  slot,
  disabled,
  busy,
  onEditSlot,
  onSelectSlotChild,
}: {
  instance: ComponentInstance;
  slot: ComponentInstance['slots'][number];
  disabled: boolean;
  busy: boolean;
  onEditSlot?: (
    instance: ComponentInstance,
    slotName: string,
    replacementSource: string
  ) => void | Promise<void>;
  onSelectSlotChild?: (child: ComponentSlotChild) => void;
}) {
  const source = instance.slotSources?.[slot.name];
  const editable = Boolean(onEditSlot && source && source.text !== undefined) && !disabled;
  const [draft, setDraft] = useState(source?.text ?? '');
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (dirtyRef.current) return;
    // Synchronize an untouched slot draft with the latest indexed source.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(source?.text ?? '');
  }, [source?.text]);

  const commit = () => {
    if (!editable || !onEditSlot || !dirtyRef.current) return;
    dirtyRef.current = false;
    void onEditSlot(instance, slot.name, draft);
  };

  return (
    <div className="ss-components-instance__slot">
      <div className="ss-components-instance__slot-header">
        <span>{slot.name}</span>
        {source && <span className="ss-components-instance__state">Static drop zone</span>}
      </div>
      {slot.children && slot.children.length > 0 && (
        <div
          className="ss-components-instance__slot-children"
          aria-label={`${slot.name} slot children`}
        >
          {slot.children.map((child) => (
            <Button
              key={child.instanceId}
              variant="ghost"
              size="compact"
              onClick={() => onSelectSlotChild?.(child)}
              disabled={!onSelectSlotChild}
              title={`Focus ${child.name} in the ${slot.name} slot`}
            >
              {child.name}
            </Button>
          ))}
        </div>
      )}
      {editable ? (
        <>
          <span className="ss-components-instance__state">Advanced source fallback</span>
          <textarea
            className="ss-components-instance__slot-input"
            aria-label={`Edit ${slot.name} slot source`}
            value={draft}
            rows={3}
            onChange={(event) => {
              dirtyRef.current = true;
              setDraft(event.currentTarget.value);
            }}
            onBlur={commit}
            disabled={busy}
          />
        </>
      ) : (
        <code className="ss-components-instance__slot-value">
          {source?.text ?? (slot.value === null ? 'Empty' : formatValue(slot.value))}
        </code>
      )}
      {!source && <span className="ss-components-instance__state">Source range unavailable</span>}
    </div>
  );
}

function bindingMessage(confidence: BindingConfidence, disabled: boolean) {
  if (disabled) return 'Instance controls are unavailable while editing the main definition.';
  if (confidence === 'sourceAnchored') {
    return 'The definition is known, but this rendered selection is not an exact invocation.';
  }
  if (confidence === 'ambiguous') {
    return 'Choose a source invocation before viewing instance values.';
  }
  if (confidence === 'none') {
    return 'Select a component usage to inspect its source-authored values.';
  }
  return null;
}

/** Read-only instance values until an adapter can prove a lossless source edit. */
export function ComponentInstanceControls({
  instance,
  component,
  bindingConfidence = 'exact',
  disabled = false,
  busy = false,
  onEditProp,
  onEditSlot,
  onSelectSlotChild,
  onInline,
  onOpenSource,
}: ComponentInstanceControlsProps) {
  if (!instance) {
    return (
      <section className="ss-components-instance" aria-labelledby="components-instance-title">
        <h3 id="components-instance-title" className="ss-components-section-title">
          Instance values
        </h3>
        <p className="ss-components-muted">Choose a usage to inspect its source-authored values.</p>
      </section>
    );
  }

  const declaredProps = component?.props ?? [];
  const instanceProps = instance.props ?? {};
  const propNames = [
    ...declaredProps.map((prop) => prop.name),
    ...Object.keys(instanceProps).filter(
      (name) => !declaredProps.some((prop) => prop.name === name)
    ),
  ];
  const message = bindingMessage(bindingConfidence, disabled);

  return (
    <section
      className="ss-components-instance"
      aria-labelledby="components-instance-title"
      aria-busy={busy}
    >
      <div className="ss-components-instance__header">
        <div>
          <h3 id="components-instance-title" className="ss-components-section-title">
            Instance values
          </h3>
          <p className="ss-components-instance__source">{sourceLabel(instance.invocation)}</p>
        </div>
        {onOpenSource && (
          <Button
            variant="ghost"
            size="compact"
            className="ss-components-instance__source-button"
            leftIcon={<CodeIcon size={14} />}
            onClick={() => onOpenSource(instance.invocation)}
          >
            Open source
          </Button>
        )}
        {onInline && (
          <Button
            variant="ghost"
            size="compact"
            className="ss-components-instance__inline-button"
            leftIcon={<ComponentsIcon size={13} />}
            onClick={() => void onInline(instance)}
            disabled={disabled || busy}
            title="Replace this proven simple component usage with its static JSX root"
          >
            Inline simple
          </Button>
        )}
      </div>

      {message && (
        <div className="ss-components-instance__notice" role="note">
          <InfoIcon size={14} aria-hidden="true" />
          <span>{message}</span>
        </div>
      )}

      <div className="ss-components-instance__rows">
        {propNames.length === 0 ? (
          <p className="ss-components-muted">No declared props or source-authored values.</p>
        ) : (
          propNames.map((name) => {
            const value = Object.prototype.hasOwnProperty.call(instanceProps, name)
              ? instanceProps[name]
              : undefined;
            const descriptor = declaredProps.find((prop) => prop.name === name);

            return (
              <InstancePropRow
                key={`${instance.id}:${name}:${encodeChoice(value)}`}
                instance={instance}
                name={name}
                descriptor={descriptor}
                value={value}
                disabled={disabled}
                busy={busy}
                onEditProp={onEditProp}
                onOpenSource={onOpenSource}
              />
            );
          })
        )}
      </div>

      {instance.slots?.length > 0 && (
        <div className="ss-components-instance__slots">
          <h4 className="ss-components-subsection-title">Slots</h4>
          {instance.slots.map((slot, index) => (
            <InstanceSlotRow
              key={`${index}-${slot.name}`}
              instance={instance}
              slot={slot}
              disabled={disabled}
              busy={busy}
              onEditSlot={onEditSlot}
              onSelectSlotChild={onSelectSlotChild}
            />
          ))}
        </div>
      )}
    </section>
  );
}
