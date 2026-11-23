import { useCallback } from 'react';
import { logger } from '../lib/logger';
import { setTerminalState } from '../lib/project';
import { sessionRegistry } from '../lib/sessionRegistry';
import type { TerminalTab } from './useTerminalManagement';

interface Params {
  projectPath: string;
  terminalTabs: TerminalTab[];
  activeTerminalTab: number;
}

/** Keeps terminal title changes and persisted manual renames in one place. */
export function useWorkspaceTerminalTabTitles({
  projectPath,
  terminalTabs,
  activeTerminalTab,
}: Params) {
  const handleTabTitleChange = useCallback(
    (changedProjectPath: string, tabId: number) => (title: string) => {
      sessionRegistry.setTerminalTabTitle(changedProjectPath, tabId, title);
    },
    []
  );

  const handleRenameTab = useCallback(
    (tabId: number, name: string) => {
      sessionRegistry.setTerminalTabCustomTitle(projectPath, tabId, name || null);
      const customTitles = sessionRegistry.getCustomTitles(projectPath);
      const activeIdx = Math.max(
        0,
        terminalTabs.findIndex((tab) => tab.id === activeTerminalTab)
      );
      void setTerminalState(projectPath, {
        tabs: terminalTabs.map((tab) => ({
          agent_id: tab.agentId,
          session_id: tab.sessionId,
          custom_title: customTitles.get(tab.id),
        })),
        active_tab_index: activeIdx,
      }).catch((error) => {
        logger.warn('[RenameTab] Failed to persist custom title', {
          error: String(error),
          tabId,
        });
      });
    },
    [activeTerminalTab, projectPath, terminalTabs]
  );

  return { handleTabTitleChange, handleRenameTab };
}
