import { EditIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tooltip } from '../primitives/Tooltip';

interface VisualEditorToggleProps {
  enabled: boolean;
  active: boolean;
  onToggle: () => void;
}

/** Shared toolbar control for the Preview and Components visual editors. */
export function VisualEditorToggle({ enabled, active, onToggle }: VisualEditorToggleProps) {
  if (!enabled) {
    return (
      <Tooltip content="Visual editing is unavailable for this project. Supported projects can be edited by clicking elements in the preview.">
        <span className="preview-edit-toggle-wrap preview-edit-control">
          <Button
            type="button"
            className="preview-edit-toggle--disabled"
            aria-disabled="true"
            tabIndex={-1}
            aria-label="Edit"
          >
            <EditIcon size={13} />
          </Button>
        </span>
      </Tooltip>
    );
  }

  return (
    <ToggleButton
      type="button"
      className="preview-edit-control"
      variant={active ? 'secondary' : 'default'}
      onClick={onToggle}
      title="Toggle visual editor"
      pressed={active}
      aria-label="Edit"
    >
      <EditIcon size={13} />
      <span className={`preview-edit-toggle-switch ${active ? 'is-on' : ''}`} aria-hidden />
    </ToggleButton>
  );
}
