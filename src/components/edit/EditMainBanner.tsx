import { CodeIcon, EditIcon } from '@/components/icons';
import type { ComponentDescriptor, ComponentId } from '../../lib/components/types';
import { Button } from '../primitives/Button';

/** State owned by the visual-editor host for the explicit definition-editing mode. */
export interface EditMainState {
  active: boolean;
  componentId: ComponentId | null;
  pendingChanges?: boolean;
  onEnter: (componentId: ComponentId) => void;
  onExit: () => void;
}

interface EditMainBannerProps {
  component: ComponentDescriptor | null;
  usageCount: number;
  state?: EditMainState;
}

function usageLabel(count: number) {
  return `${count.toLocaleString()} source ${count === 1 ? 'usage' : 'usages'}`;
}

/**
 * Persistent context for definition-level editing. The inactive treatment is
 * intentionally a compact invitation; the active treatment makes the blast
 * radius and exit action impossible to miss.
 */
export function EditMainBanner({ component, usageCount, state }: EditMainBannerProps) {
  if (!component || !state) return null;

  const isActive = state.active && state.componentId === component.id;

  if (!isActive) {
    return (
      <div className="ss-components-main-banner" data-testid="edit-main-banner">
        <div className="ss-components-main-banner__copy">
          <span className="ss-components-main-banner__icon" aria-hidden="true">
            <EditIcon size={14} />
          </span>
          <span>
            Open the main source to edit <strong>{usageLabel(usageCount)}</strong>.
          </span>
        </div>
        <Button
          variant="secondary"
          size="compact"
          className="ss-components-main-banner__action"
          leftIcon={<CodeIcon size={14} />}
          onClick={() => state.onEnter(component.id)}
        >
          Open main source
        </Button>
      </div>
    );
  }

  return (
    <div
      className="ss-components-main-banner ss-components-main-banner--active"
      data-testid="edit-main-banner"
      role="status"
      aria-live="polite"
    >
      <div className="ss-components-main-banner__copy">
        <span className="ss-components-main-banner__icon" aria-hidden="true">
          <EditIcon size={14} />
        </span>
        <span>
          Main source selected: <strong>{component.name}</strong> · changes affect{' '}
          <strong>{usageLabel(usageCount)}</strong>
          {state.pendingChanges && (
            <span className="ss-components-main-banner__pending"> · unsaved changes</span>
          )}
        </span>
      </div>
      <Button
        variant="ghost"
        size="compact"
        className="ss-components-main-banner__action"
        onClick={state.onExit}
      >
        Clear context
      </Button>
    </div>
  );
}
