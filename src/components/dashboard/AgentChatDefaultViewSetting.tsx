import { useAgentChatPreferences } from '../../hooks/useAgentChatPreferences';
import { useOptionalToast } from '../../contexts/ToastContext';
import { SegmentedControl } from '../primitives/SegmentedControl';

/** Experimental default for the Agent panel; projects can override it in place. */
export function AgentChatDefaultViewSetting() {
  const { defaultView, setDefaultView } = useAgentChatPreferences();
  const { showToast } = useOptionalToast();

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-row-label">Agent panel default</span>
        <span className="settings-row-description">
          Choose whether projects open to Terminal or Codex Chat. Each project can remember its own
          choice in the Agent panel.
        </span>
      </div>
      <SegmentedControl
        value={defaultView}
        aria-label="Default Agent panel view"
        options={[
          { value: 'terminal', label: 'Terminal' },
          { value: 'chat', label: 'Chat' },
        ]}
        onValueChange={(value) => {
          if (!setDefaultView(value as 'terminal' | 'chat')) {
            showToast('Could not save the default Agent panel view.', 'error');
          }
        }}
      />
    </div>
  );
}
