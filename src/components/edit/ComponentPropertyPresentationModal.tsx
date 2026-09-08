import { useEffect, useState } from 'react';
import type { ComponentDescriptor } from '../../lib/components/types';
import type {
  ComponentPropertyPresentation,
  ComponentPresentationMetadata,
} from '../../lib/components/property-metadata';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { TextField } from '../primitives/TextField';

interface PropertyDraft {
  label: string;
  group: string;
  order: string;
}

export interface ComponentPropertyPresentationModalProps {
  component: ComponentDescriptor;
  metadata?: ComponentPresentationMetadata | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (metadata: ComponentPresentationMetadata) => void | Promise<void>;
}

function draftsFor(
  component: ComponentDescriptor,
  metadata: ComponentPresentationMetadata | null | undefined
): Record<string, PropertyDraft> {
  const byName = new Map((metadata?.properties ?? []).map((item) => [item.name, item]));
  return Object.fromEntries(
    component.props.map((prop) => {
      const presentation = byName.get(prop.name);
      return [
        prop.name,
        {
          label: presentation?.label ?? prop.label ?? '',
          group: presentation?.group ?? prop.group ?? '',
          order:
            presentation?.order !== undefined
              ? String(presentation.order)
              : prop.order !== null && prop.order !== undefined
                ? String(prop.order)
                : '',
        },
      ];
    })
  );
}

function metadataFromDrafts(
  component: ComponentDescriptor,
  drafts: Record<string, PropertyDraft>
): ComponentPresentationMetadata {
  const properties: ComponentPropertyPresentation[] = component.props.flatMap((prop) => {
    const draft = drafts[prop.name];
    if (!draft) return [];
    const order = draft.order.trim() === '' ? undefined : Number(draft.order);
    return [
      {
        name: prop.name,
        ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
        ...(draft.group.trim() ? { group: draft.group.trim() } : {}),
        ...(Number.isFinite(order) ? { order } : {}),
      },
    ];
  });
  return { componentId: component.id, properties };
}

/** Project-scoped presentation only; source prop names remain immutable. */
export function ComponentPropertyPresentationModal({
  component,
  metadata,
  isOpen,
  onClose,
  onSave,
}: ComponentPropertyPresentationModalProps) {
  const [drafts, setDrafts] = useState<Record<string, PropertyDraft>>(() =>
    draftsFor(component, metadata)
  );

  useEffect(() => {
    if (!isOpen) return;
    // Rehydrate each opening from the current project-scoped store.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts(draftsFor(component, metadata));
  }, [component, isOpen, metadata]);

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={`Organize ${component.name} properties`}
      className="ss-components-property-presentation-modal"
    >
      <div className="ss-components-property-presentation">
        <p className="ss-components-muted">
          Presentation metadata is saved to this project only. Source prop names stay unchanged;
          blank fields restore the source presentation.
        </p>
        <div className="ss-components-property-presentation__list">
          {component.props.map((prop) => {
            const draft = drafts[prop.name] ?? { label: '', group: '', order: '' };
            const update = (patch: Partial<PropertyDraft>) =>
              setDrafts((current) => ({
                ...current,
                [prop.name]: { ...draft, ...patch },
              }));
            return (
              <div key={prop.name} className="ss-components-property-presentation__row">
                <code title="Source prop name">{prop.name}</code>
                <TextField
                  aria-label={`Label for ${prop.name}`}
                  placeholder={prop.name}
                  value={draft.label}
                  onChange={(event) => update({ label: event.currentTarget.value })}
                />
                <TextField
                  aria-label={`Group for ${prop.name}`}
                  placeholder="Properties"
                  value={draft.group}
                  onChange={(event) => update({ group: event.currentTarget.value })}
                />
                <TextField
                  aria-label={`Order for ${prop.name}`}
                  type="number"
                  inputMode="numeric"
                  placeholder="Auto"
                  value={draft.order}
                  onChange={(event) => update({ order: event.currentTarget.value })}
                />
              </div>
            );
          })}
        </div>
        <div className="ss-components-property-presentation__actions">
          <Button variant="ghost" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={() => {
              void onSave(metadataFromDrafts(component, drafts));
              onClose();
            }}
          >
            Save organization
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
