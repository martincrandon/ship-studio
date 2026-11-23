import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkIdeAvailability } from '../../lib/ide';
import type { FileContent } from '../../lib/code';
import type { EditorSelectionInfo } from './CodeFileEditor';
import { CodeViewer } from './CodeViewer';

const { trackEventMock } = vi.hoisted(() => ({ trackEventMock: vi.fn() }));

vi.mock('../../lib/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/analytics')>();
  return { ...actual, trackEvent: trackEventMock };
});

vi.mock('../../lib/ide', () => ({
  checkIdeAvailability: vi.fn().mockResolvedValue({ vscode: false, cursor: false }),
  openInIde: vi.fn(),
}));

vi.mock('./CodeFileEditor', () => ({
  CodeFileEditor: ({
    onSelectionChange,
  }: {
    onSelectionChange?: (selection: EditorSelectionInfo | null) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onSelectionChange?.({
          text: 'selected code',
          startLine: 27,
          endLine: 53,
          mouseX: 100,
          mouseY: 100,
        })
      }
    >
      Select code
    </button>
  ),
}));

const fileContent: FileContent = {
  content: 'selected code',
  isBinary: false,
  isTruncated: false,
  size: 13,
  language: 'json',
};

beforeEach(() => {
  vi.mocked(checkIdeAvailability).mockResolvedValue({ vscode: false, cursor: false });
});

describe('CodeViewer selection reference', () => {
  it('uses right when collapsed and down when expanded', async () => {
    await act(async () => {
      render(
        <CodeViewer
          projectPath="/project"
          filePath="package-lock.json"
          fileContent={fileContent}
          isLoading={false}
          error={null}
          onSendToAgent={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Select code' }));

    const reference = screen.getByRole('button', { name: 'package-lock.json:27-53' });
    const attachment = reference.parentElement;
    expect(reference).toHaveAttribute('aria-expanded', 'false');
    expect(attachment).toHaveClass('code-selection-attachment');
    expect(reference.querySelector('[data-icon-name="ChevronRightIcon"]')).toHaveAttribute(
      'width',
      '14'
    );
    expect(reference.querySelector('[data-icon-name="ChevronIcon"]')).not.toBeInTheDocument();

    fireEvent.click(reference);

    expect(reference).toHaveAttribute('aria-expanded', 'true');
    expect(reference.querySelector('[data-icon-name="ChevronIcon"]')).toHaveAttribute(
      'width',
      '14'
    );
    expect(reference.querySelector('[data-icon-name="ChevronRightIcon"]')).not.toBeInTheDocument();
    expect(screen.getByText('selected code')).toBeInTheDocument();
  });
});

describe('CodeViewer send to agent', () => {
  it('keeps the selection and question when the handoff is rejected', async () => {
    trackEventMock.mockClear();
    const onSendToAgent = vi.fn(() => false as const);
    await act(async () => {
      render(
        <CodeViewer
          projectPath="/project"
          filePath="package-lock.json"
          fileContent={fileContent}
          isLoading={false}
          error={null}
          onSendToAgent={onSendToAgent}
        />
      );
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Select code' }));
    const question = screen.getByPlaceholderText('Ask about this code...');
    fireEvent.change(question, { target: { value: 'Why is this value needed?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy to agent' }));

    expect(onSendToAgent).toHaveBeenCalledWith(
      expect.stringContaining('Why is this value needed?')
    );
    expect(screen.getByRole('button', { name: 'package-lock.json:27-53' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask about this code...')).toHaveValue(
      'Why is this value needed?'
    );
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('records and clears an accepted Chat draft handoff', async () => {
    trackEventMock.mockClear();
    const onSendToAgent = vi.fn(() => 'chat-draft' as const);
    await act(async () => {
      render(
        <CodeViewer
          projectPath="/project"
          filePath="package-lock.json"
          fileContent={fileContent}
          isLoading={false}
          error={null}
          onSendToAgent={onSendToAgent}
        />
      );
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Select code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy to agent' }));

    expect(trackEventMock).toHaveBeenCalledWith(
      'code_snippet_sent_to_agent',
      expect.objectContaining({ file_extension: 'json', line_count: 27 })
    );
    expect(screen.queryByPlaceholderText('Ask about this code...')).not.toBeInTheDocument();
  });
});
