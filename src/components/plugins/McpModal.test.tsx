import { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import { ModalProvider, useModal } from '../../contexts/ModalContext';
import { McpModal } from './McpModal';

function OpenMcpModal() {
  const { open } = useModal('mcp');

  useEffect(() => {
    open();
  }, [open]);

  return <McpModal projectPath="/tmp/project" />;
}

describe('McpModal extension filtering', () => {
  it('filters connected servers through the shared search field', async () => {
    mockIPC((command) => {
      if (command === 'list_mcp_servers') {
        return [
          {
            name: 'Alpha Server',
            command_or_url: 'npx alpha-server',
            status: 'connected',
            scope: 'user',
          },
          {
            name: 'Beta Server',
            command_or_url: 'npx beta-server',
            status: 'error',
            scope: 'project',
          },
        ];
      }
      return undefined;
    });

    render(
      <ModalProvider>
        <OpenMcpModal />
      </ModalProvider>
    );

    expect(await screen.findByText('Alpha Server')).toBeInTheDocument();
    expect(screen.getByText('Beta Server')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter MCP servers' }), {
      target: { value: 'beta' },
    });

    await waitFor(() => {
      expect(screen.queryByText('Alpha Server')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Beta Server')).toBeInTheDocument();
    expect(screen.getByText('project')).toHaveClass('extension-scope-badge--project');
    expect(screen.getByTitle('Error')).toHaveClass('error');

    vi.clearAllMocks();
  });
});
