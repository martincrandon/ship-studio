/** Standalone project-level CSS variables panel. */

import { CloseIcon } from '@/components/icons';
import type { useCssVariables } from '../../hooks/useCssVariables';
import { IconButton } from '../primitives/IconButton';
import { CssVariablesPanel } from './CssVariablesPanel';

interface VariablesPanelProps {
  variablesState: ReturnType<typeof useCssVariables>;
  onClose: () => void;
}

/** Shared panel chrome for the project-wide Variables editor. */
export function VariablesPanel({ variablesState, onClose }: VariablesPanelProps) {
  const variableNames = [...new Set(variablesState.variables.map((variable) => variable.name))];

  return (
    <div
      className="ss-edit-panel ss-variables-panel ss-variables-panel--dockable"
      data-testid="variables-panel"
    >
      <div className="ss-edit-panel__header" data-dockable-drag-handle>
        <span className="ss-edit-panel__title">Variables</span>
        <span className="ss-edit-panel__header-actions">
          <IconButton
            variant="ghost"
            size="compact"
            onClick={onClose}
            title="Close Variables panel"
            aria-label="Close Variables panel"
            icon={<CloseIcon size={14} />}
          />
        </span>
      </div>

      <div className="ss-edit-panel__body">
        <CssVariablesPanel
          variables={variablesState.variables}
          loading={variablesState.loading}
          variableNames={variableNames}
          onSetValue={variablesState.setValue}
          onAddVariable={(name, value) => void variablesState.addVariable(name, value)}
        />
      </div>
    </div>
  );
}
