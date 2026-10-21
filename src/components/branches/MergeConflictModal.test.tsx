import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastContext } from '../../contexts/ToastContext';

const { copyMock } = vi.hoisted(() => ({ copyMock: vi.fn() }));

vi.mock('../../hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copy: copyMock, isCopied: false, error: null }),
}));

vi.mock('../../lib/conflicts', () => ({ abortMerge: vi.fn() }));

import { MergeConflictModal } from './MergeConflictModal';

function renderModal(onSendToAgent?: (prompt: string) => 'terminal' | 'chat-draft' | false | void) {
  const showToast = vi.fn();
  const onClose = vi.fn();
  render(
    <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: vi.fn() }}>
      <MergeConflictModal
        projectPath="/test/project"
        currentBranch="main"
        targetBranch="feature/new"
        sourceBranch="feature/new"
        files={['src/app.ts']}
        onSendToAgent={onSendToAgent}
        onAborted={vi.fn()}
        onClose={onClose}
      />
    </ToastContext.Provider>
  );
  return { showToast, onClose };
}

describe('MergeConflictModal agent handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    copyMock.mockResolvedValue(true);
  });

  it('keeps the prompt and dialog available when the selected route rejects it', () => {
    const onSendToAgent = vi.fn(() => false as const);
    const { showToast, onClose } = renderModal(onSendToAgent);

    fireEvent.click(screen.getByRole('button', { name: 'Copy & Fix' }));

    expect(onSendToAgent).toHaveBeenCalledWith(expect.stringContaining('src/app.ts'));
    expect(copyMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.getByText(/Please resolve the conflicts in those files/)).toBeInTheDocument();
  });

  it('uses the no-handler clipboard fallback and closes only after confirmed copy', async () => {
    const { showToast, onClose } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Copy & Fix' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(copyMock).toHaveBeenCalledWith(expect.stringContaining('src/app.ts'));
    expect(showToast).toHaveBeenCalledWith('Prompt copied to clipboard.', 'success');
  });

  it('leaves the dialog open and reports an error when the clipboard copy fails', async () => {
    copyMock.mockResolvedValue(false);
    const { showToast, onClose } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Copy & Fix' }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not copy the prompt to the clipboard.', 'error')
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Please resolve the conflicts in those files/)).toBeInTheDocument();
  });

  it('keeps Chat review explicit after an accepted draft handoff', () => {
    const onSendToAgent = vi.fn(() => 'chat-draft' as const);
    const { showToast, onClose } = renderModal(onSendToAgent);

    fireEvent.click(screen.getByRole('button', { name: 'Copy & Fix' }));

    expect(copyMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'Prompt added to Chat draft. Review it, then press Send.',
      'success'
    );
    expect(onClose).toHaveBeenCalled();
  });
});
