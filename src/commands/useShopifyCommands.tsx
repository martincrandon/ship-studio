import { useCommands } from './useCommands';
import { useOpenModal } from '../contexts/ModalContext';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  getShopifyStore,
  buildSectionPrompt,
  buildPushPrompt,
  shopifyAdminUrl,
} from '../lib/shopify';
import type { ProjectType } from '../lib/static-server';
import { asCommandError, formatCommandError } from '../lib/errors';
import { ShopifyBagIcon } from '@/components/icons';
import {
  CHAT_PROMPT_STAGED_MESSAGE,
  promptHandoffSuccessMessage,
  type AgentPromptHandoffResult,
} from '../lib/agentPromptHandoff';

/**
 * Palette commands for Shopify theme projects. Called from `WorkspaceView`
 * (which owns `projectType` and the agent-terminal paste handler). All
 * commands are gated to Shopify theme projects only.
 */
export interface UseShopifyCommandsParams {
  projectType: ProjectType;
  projectPath: string;
  onSendToAgent: (prompt: string) => AgentPromptHandoffResult;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export function useShopifyCommands({
  projectType,
  projectPath,
  onSendToAgent,
  showToast,
}: UseShopifyCommandsParams) {
  const openModal = useOpenModal();
  const isTheme = projectType === 'shopifytheme';

  useCommands(
    () => [
      {
        id: 'shopify.buildSection',
        title: 'Build a new theme section with AI',
        icon: <ShopifyBagIcon />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['shopify', 'liquid', 'section', 'block'],
        run: () => {
          const result = onSendToAgent(buildSectionPrompt());
          const message = promptHandoffSuccessMessage(
            result,
            'Prompt pasted — press Enter in the terminal to run it',
            CHAT_PROMPT_STAGED_MESSAGE
          );
          if (message) showToast(message, 'success');
        },
      },
      {
        id: 'shopify.pushTheme',
        title: 'Push theme to Shopify with AI',
        icon: <ShopifyBagIcon />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['shopify', 'deploy', 'publish', 'upload'],
        run: async () => {
          try {
            const store = await getShopifyStore(projectPath);
            if (!store) {
              showToast('Connect a Shopify store first (see the preview pane)', 'error');
              return;
            }
            const result = onSendToAgent(buildPushPrompt(store));
            const message = promptHandoffSuccessMessage(
              result,
              'Prompt pasted — press Enter in the terminal to run it',
              CHAT_PROMPT_STAGED_MESSAGE
            );
            if (message) showToast(message, 'success');
          } catch (err) {
            showToast(formatCommandError(asCommandError(err)), 'error');
          }
        },
      },
      {
        id: 'shopify.changeStore',
        title: 'Change Shopify store…',
        icon: <ShopifyBagIcon />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['shopify', 'store', 'connect', 'myshopify'],
        run: () => openModal('shopifyStore'),
      },
      {
        id: 'shopify.openAdmin',
        title: 'Open Shopify admin',
        icon: <ShopifyBagIcon />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['shopify', 'dashboard', 'admin'],
        run: async () => {
          try {
            const store = await getShopifyStore(projectPath);
            if (!store) {
              showToast('Connect a Shopify store first (see the preview pane)', 'error');
              return;
            }
            await openUrl(shopifyAdminUrl(store));
          } catch (err) {
            showToast(formatCommandError(asCommandError(err)), 'error');
          }
        },
      },
    ],
    [isTheme, projectPath, onSendToAgent, showToast, openModal]
  );
}
