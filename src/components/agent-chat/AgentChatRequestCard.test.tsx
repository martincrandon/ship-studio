import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChatRequestCard } from './AgentChatRequestCard';
import type { ChatRequest } from '@/lib/agentChat';
import { interruptAgentChatThread, respondToAgentChatRequest } from '@/lib/agentChatStore';

vi.mock('@/lib/agentChatStore', () => ({
  interruptAgentChatThread: vi.fn().mockResolvedValue({}),
  respondToAgentChatRequest: vi.fn().mockResolvedValue({}),
}));

function approvalRequest(availableDecisions: unknown[]): ChatRequest {
  return {
    id: 'request-1',
    method: 'item/commandExecution/requestApproval',
    kind: 'approval',
    title: 'Approve command',
    params: {
      command: 'echo safe',
      availableDecisions,
    },
  };
}

describe('AgentChatRequestCard approval decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows only offered base decisions when Codex also offers unsupported amendments', async () => {
    render(
      <AgentChatRequestCard
        projectPath="/project-a"
        threadId="thread-a"
        request={approvalRequest([
          { acceptWithExecpolicyAmendment: { execpolicyAmendment: [] } },
          'applyNetworkPolicyAmendment',
          'decline',
          'cancel',
          'acceptEverything',
        ])}
      />
    );

    expect(screen.getByText(/policy change that Chat cannot apply/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /policy update/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /network access/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /acceptEverything/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => {
      expect(respondToAgentChatRequest).toHaveBeenCalledWith(
        '/project-a',
        'thread-a',
        'request-1',
        { decision: 'decline' }
      );
    });
  });

  it('explains amendment-only requests and leaves Stop turn available', () => {
    render(
      <AgentChatRequestCard
        projectPath="/project-a"
        threadId="thread-a"
        request={approvalRequest([
          'acceptWithExecpolicyAmendment',
          { applyNetworkPolicyAmendment: { networkPolicyAmendment: {} } },
        ])}
      />
    );

    expect(screen.getByText(/No supported approval decision was offered/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /policy update|network access/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop turn' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop turn' }));
    expect(interruptAgentChatThread).toHaveBeenCalledWith('/project-a', 'thread-a');
  });

  it('does not invent approval decisions when Codex omits the offered list', () => {
    const request = approvalRequest([]);
    delete request.params.availableDecisions;
    render(<AgentChatRequestCard projectPath="/project-a" threadId="thread-a" request={request} />);

    expect(screen.getByText(/did not provide supported approval decisions/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop turn' })).toBeInTheDocument();
  });
});
