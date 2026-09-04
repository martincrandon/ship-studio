import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentMutationPreview } from '../../lib/components/types';
import { ComponentMutationReviewModal } from './ComponentMutationReviewModal';

const preview: ComponentMutationPreview = {
  plan: {
    files: [
      {
        file: 'src/Page.tsx',
        expectedHash: 'before',
        expectedResultHash: 'after',
        edits: [{ start: 0, end: 0, text: '<Card />' }],
      },
    ],
    expectedRevision: 'revision-1',
  },
  files: [
    {
      file: 'src/Page.tsx',
      beforeHash: 'before',
      afterHash: 'after',
      diff: '@@ -1,1 +1,1 @@\n-<main />\n+<Card /><main />',
      additions: 1,
      deletions: 1,
    },
  ],
};

describe('ComponentMutationReviewModal', () => {
  it('shows the exact diff and requires an explicit apply action', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ComponentMutationReviewModal preview={preview} onCancel={onCancel} onConfirm={onConfirm} />
    );

    expect(
      screen.getByRole('dialog', { name: 'Review component source changes' })
    ).toBeInTheDocument();
    expect(screen.getByText('src/Page.tsx')).toBeInTheDocument();
    expect(screen.getByText('+<Card /><main />')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('allows canceling before any write', () => {
    const onCancel = vi.fn();
    render(
      <ComponentMutationReviewModal preview={preview} onCancel={onCancel} onConfirm={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
